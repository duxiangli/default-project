<#
  常驻看门狗（2026-09-28）
  为什么需要：2026-09-27 23:01 起 watcher 静默死亡约 14 小时，期间
    熔断器 green、stderr 静、计划任务状态 Ready（不是 Failed）、CI 全绿、无人察觉。
    validate 里的心跳检查**只在有人本地跑 validate 时**才生效——它抓得住，但**不会自己触发**。
    真正的自动兜底必须是一个独立于 watcher 自己的周期任务。

  动作：
    1. 读 logs/watcher.log 最后心跳，算静默时长
    2. 静默超阈值（默认 7 分钟 = 3 个轮询周期 + 60s 余量）
       或 watcher 进程不存在 → 重启它
    3. 重启走「先杀干净再起」：Stop-ScheduledTask 不会杀子进程（实测 2026-09-27），
       故必须再杀 node 残留，否则新实例会撞上陈旧锁之外的旧进程
    4. 一切动作写 logs/watchdog.log，供事后审计

  零凭据：只用本机进程与文件，不触网。
#>
param(
  [int]    $MaxSilenceSec = 420,
  [string] $TaskName      = 'OpenCode-ExpertTeam-Autodispatch',
  [string] $Repo          = (Split-Path -Parent $PSScriptRoot),
  # 只判定不动作。用来在不动真实常驻的前提下验证心跳解析与判定分支
  # （否则测「能重启」就必然要先把常驻杀掉）。
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $Repo 'logs\watchdog.log'
$wlog = Join-Path $Repo 'logs\watcher.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function W($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding utf8
}

# 1) 有没有活着�� watcher 进程
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'autodispatch-watcher' })
$alive = $procs.Count -gt 0

# 2) 最后心跳
$silence = $null
$lastAt = $null
if (Test-Path $wlog) {
  $line = Get-Content $wlog -Encoding utf8 | Where-Object { $_ -match '^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]' } | Select-Object -Last 1
  if ($line -and $line -match '^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]') {
    $lastAt = [datetime]::ParseExact(("{0} {1}" -f $Matches[1], $Matches[2]), 'yyyy-MM-dd HH:mm:ss', $null)
    # watcher.log 里记的是 UTC（2026-09-27 实测确认），故与 UtcNow 相减，不能用本地时间
    $silence = [int]((Get-Date).ToUniversalTime() - $lastAt).TotalSeconds
  }
}

$needRestart = $false
$why = ''
if (-not $alive) { $needRestart = $true; $why = 'watcher 进程不存在' }
elseif ($null -ne $silence -and $silence -gt $MaxSilenceSec) { $needRestart = $true; $why = ('心跳静默 {0}s > {1}s' -f $silence, $MaxSilenceSec) }
elseif ($null -eq $silence) { $needRestart = $true; $why = '无法解析 watcher.log 最后心跳' }

# 悬空序列号扫描：放在 skip 判断**之前**，让它每轮都重申。
# 派单日志台账的行是**子会话**写的，而序列号是 watcher 启动时就宣告的——两者之间有个窗口：
# 被杀掉时序列号已在 watcher.log 里「已派单」，台账却永远不会有行。那样就留下一个悬空序列号：
# 审计者查「这单评审了什么」会一无所获，看起来像漏评审。
# 若只在重启分支里报，这个已发生的悬空号会永远沉底——直到下一次重启才被提起，甚至永不提起。
#
# 关键：必须区分「在途」与「作废」。台账行由子会话收尾时才写入，通常几分钟内落库；
# 刚宣告还没落台账多半是在途，不是丢失。若一律叫「作废」，就是在报假警——
# 一只会叫的看门狗比没有看门狗更坏：人会学会忽略它。
$InFlightWindow = [timespan]::FromMinutes(30)   # 宣告后 30 分钟内未落台账 → 在途，不判作废
$ledger = Join-Path $Repo 'docs\expert-team\runbook\派单日志.md'
$annAt = @{}                # 序列号 -> 最近一次宣告时刻（UTC）
if (Test-Path $wlog) {
  foreach ($ln in (Get-Content $wlog -Encoding utf8)) {
    $stamp = $null
    if ($ln -match '^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]') {
      # watcher.log 记的是 UTC：ParseExact 出来是无 Kind 的 DateTime，必须 SpecifyKind 成 Utc，
      # 否则与 UtcNow 相减会差一个时区偏移（本机 UTC+8 即差 8 小时，判成「8 小时前」）。
      $stamp = [datetime]::SpecifyKind(
        [datetime]::ParseExact(('{0} {1}' -f $Matches[1], $Matches[2]), 'yyyy-MM-dd HH:mm:ss', $null),
        'Utc')
    }
    foreach ($m in [regex]::Matches($ln, 'DSP-\d{8}-\d{4}-\d{2}')) {
      if ($null -ne $stamp) { $annAt[$m.Value] = $stamp }
    }
  }
}
$ledgerText = ''
if (Test-Path $ledger) { $ledgerText = Get-Content $ledger -Raw -Encoding utf8 }
# 注意：这里不要写 `[int](Get-Date).ToUniversalTime()` —— 强转先于方法调用绑定，
# 会把 DateTime 整个转成 Int32 而直接抛 InvalidCastIConvertible（实测踩过两次）。
$nowUtc = (Get-Date).ToUniversalTime()
$voided = @()
$inFlight = @()
foreach ($sn in $annAt.Keys) {
  if ($ledgerText -match [regex]::Escape($sn)) { continue }
  if (($nowUtc - $annAt[$sn]) -le $InFlightWindow) { $inFlight += $sn } else { $voided += $sn }
}

if (-not $needRestart) {
  # NOTE: build the message first, then log it. Nesting quotes inside $( ) inside a
  # double-quoted string breaks the PowerShell 5.1 parser (unterminated string).
  $silenceTxt = '未知'
  if ($null -ne $silence) { $silenceTxt = '{0}s' -f $silence }
  $msg = '[skip] watcher 存活（{0} 个进程），静默 {1}' -f $procs.Count, $silenceTxt
  W $msg
  if ($inFlight.Count -gt 0) { W ('    在途 {0} 个序列号已宣告未落台账（正常，子会话收尾时写入）：' -f $inFlight.Count) }
  if ($voided.Count -gt 0) {
    W ('[!] **{0} 个序列号宣告后超 {1} 分钟仍未落台账，判定丢失/被打断，一律作废**：' -f $voided.Count, [int]($InFlightWindowSec / 60))
    W ('    ' + (($voided | Sort-Object) -join ' '))
  }
  exit 0
}

W "[!] 触发重启：$why"
if ($voided.Count -gt 0) {
  W ('[!] 下列序列号宣告后超 {0} 分钟仍未落台账（疑被本次重启打断或已丢失），**一律作废**��' -f [int]($InFlightWindowSec / 60))
  W ('    ' + (($voided | Sort-Object) -join ' '))
}

if ($DryRun) {
  W '[dry-run] 判定为需重启，但 DryRun 已指定：不执行任何杀进程/启任务动作'
  exit 0
}
# 3) 先杀干净（Stop-ScheduledTask 不杀子进程——实测）
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'autodispatch-watcher' } |
  ForEach-Object { W "  杀 node pid=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='opencode-cli.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'run --agent' } |
  ForEach-Object { W "  杀残留 opencode run pid=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8
$after = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'autodispatch-watcher' })
W ("[ok] 已重启，进程数 $($after.Count)；若为 0 请查 $wlog")
