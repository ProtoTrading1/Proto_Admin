# Register Proto SQL Bridge as a Windows Scheduled Task (BLADERUNNER-PC)
# Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File scripts\install-sql-bridge-task.ps1

$ErrorActionPreference = 'Stop'
$TaskName = 'ProtoSqlBridge'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Python = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if (-not $Python) { $Python = (Get-Command py -ErrorAction SilentlyContinue)?.Source }
if (-not $Python) { throw 'Python not found on PATH. Install Python 3.10+.' }

$BridgeScript = Join-Path $RepoRoot 'scripts\sql-stmast-bridge.py'
if (-not (Test-Path $BridgeScript)) { throw "Bridge script not found: $BridgeScript" }

$Action = New-ScheduledTaskAction -Execute $Python -Argument "`"$BridgeScript`"" -WorkingDirectory $RepoRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed existing task: $TaskName"
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description 'Proto read-only STMAST bridge for Vercel admin (port 8765)' | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "Start now:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Test LAN:   node scripts\test-bridge.mjs 8626100145"
Write-Host "Full guide: scripts\install-sql-bridge-service.md"
