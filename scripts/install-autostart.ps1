<#
  专家团 watcher 常驻自启安装器（Windows 计划任务）

  作用：注册一个「用户登录时」自动启动的计划任务，运行 scripts/autodispatch-watcher.mjs 常驻模式。
  安全性：
    - 复用 watcher 自带的单实例锁（autodispatch-state-lock.json）；若已有实例在跑，新实例会自行退出，不会重复派单
    - 熔断器兜底：连续失败 3 次自动停止派单，等通道恢复（不会无限重试毒化服务）
    - 日志写到仓库 logs/ 目录（已在 .gitignore 中）
  用法：
    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1            # 安装
    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall  # 卸载
    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Start     # 安装后立即启动
#>
param(
  [switch]$Uninstall,
  [switch]$Start,
  # 只注册/刷新看门狗，不碰主任务。
  # 为什么需要：Register-ScheduledTask -Force 会**停掉正在运行的主任务**（实测 2026-09-28），
  # 于是「只想更新看门狗」也会顺手杀掉在途派单、打断子会话、留下悬空序列号。
  # 实测就因此打断了 DSP-20260928-1141-01。改看门狗请用这个开关。
  [switch]$WatchdogOnly,
  [int]$IntervalSeconds = 120,
  [string]$TaskName = "OpenCode-ExpertTeam-Autodispatch"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$watcher = Join-Path $repo "scripts\autodispatch-watcher.mjs"
$logDir = Join-Path $repo "logs"
$logFile = Join-Path $logDir "watcher.log"
$errFile = Join-Path $logDir "watcher.err.log"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

Write-Host "Repo     : $repo"
Write-Host "Node     : $node"

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[OK] Unregistered scheduled task: $TaskName" -ForegroundColor Yellow
  } else {
    Write-Host "[--] Task not found: $TaskName" -ForegroundColor Yellow
  }
  return
}

if (-not (Test-Path $watcher)) { throw "找不到 watcher：$watcher" }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
# principal 被主任务与看门狗共用，故提到守卫之外
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# -WatchdogOnly：只刷新看门狗，跳过主任务。理由见 param 处的注释——
# 重新注册主任务会停掉正在跑的常驻，从而打断在途派单。
if (-not $WatchdogOnly) {
# 包装成 .cmd解决计划任务里 node 路径含空格 + 工作目录两个经典坑
$cmdPath = Join-Path $logDir "run-watcher.cmd"
$cmd = @(
  "@echo off",
  "chcp 65001 >nul",
  "cd /d `"$repo`"",
  "`"$node`" `"$watcher`" --interval $IntervalSeconds --dispatch-timeout 3600 >> `"$logFile`" 2>> `"$errFile`""
) -join "`r`n"
# 用 oem/utf8 混合环境安全的写法ASCII 兜底路径含非 ASCII 时由 chcp 65001 兜住
Set-Content -Path $cmdPath -Value $cmd -Encoding UTF8
Write-Host "Launcher : $cmdPath"

$action = New-ScheduledTaskAction -Execute $cmdPath -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "[OK] Registered: $TaskName (at logon; restart 3x/5min; ignore duplicate instances)" -ForegroundColor Green
Write-Host "Log      : $logFile"
}

# - 看门狗2026-09-28因 14 小时静默停服而加 -
# 背景那次 watcher 退出后计划任务状态是 Ready不是 Failed熔断器 green
#   stderr 静CI 全绿**没有任何东西发现它不在了**
# 而上面那个 -RestartCount 实测无效7 分钟无反应所以不能指望它兜底
# 故注册一个**独立于 watcher 自己**的周期任务每 5 分钟查心跳超阈值或进程不在就重启
# 注意RestartCount 那一项留着但**不再当兜底**-它对批处理动作不生效已实测
$watchdogName = "OpenCode-ExpertTeam-Watchdog"
$wdScript = Join-Path $repo 'scripts\watchdog.ps1'
$wdLog = Join-Path $repo 'logs\watchdog.log'
if (Test-Path $wdScript) {
  if (Get-ScheduledTask -TaskName $watchdogName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $watchdogName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $watchdogName -Confirm:$false
  }
  # NOTE: keep this comment ASCII-only. Non-ASCII punctuation inside PowerShell
  # comments has broken the whole script parser (unterminated string) more than once.
  # Build the argument string by joining parts; do NOT use backtick-escaped quotes.
  $wdArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $wdScript)
  $wdArgLine = ($wdArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $wdAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $wdArgLine -WorkingDirectory $repo
  $wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
  $wdSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $watchdogName -Action $wdAction -Trigger $wdTrigger `
    -Settings $wdSettings -Principal $principal -Force | Out-Null
  Write-Host "[OK] Registered: $watchdogName (every 5min; restart watcher if heartbeat stale >7min)" -ForegroundColor Green
  Write-Host "WdLog    : $wdLog"
} else {
  Write-Warn "[--] 未找到 scripts\watchdog.ps1，跳过看门狗注册（将无法自动发现 watcher 停服）"
}

if ($Start) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $t = Get-ScheduledTask -TaskName $TaskName
  Write-Host "[OK] Started. State: $($t.State)" -ForegroundColor Green
  if (Test-Path $logFile) { Get-Content $logFile -Tail 5 }
}

Write-Host ""
Write-Host "Operations:" -ForegroundColor Cyan
Write-Host "  status  : Get-ScheduledTask -TaskName $TaskName"
Write-Host "  start   : Start-ScheduledTask -TaskName $TaskName"
Write-Host "  stop    : Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "  health  : node scripts\autodispatch-watcher.mjs --health --once"
Write-Host "  breaker : node scripts\autodispatch-watcher.mjs --reset-breaker --once"