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

# 包装成 .cmd：解决「计划任务里 node 路径含空格 + 工作目录」两个经典坑
$cmdPath = Join-Path $logDir "run-watcher.cmd"
$cmd = @(
  "@echo off",
  "chcp 65001 >nul",
  "cd /d `"$repo`"",
  "`"$node`" `"$watcher`" --interval $IntervalSeconds --dispatch-timeout 3600 >> `"$logFile`" 2>> `"$errFile`""
) -join "`r`n"
# 用 oem/utf8 混合环境安全的写法：ASCII 兜底，路径含非 ASCII 时由 chcp 65001 兜住
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
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "[OK] Registered: $TaskName (at logon; restart 3x/5min; ignore duplicate instances)" -ForegroundColor Green
Write-Host "Log      : $logFile"

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