param(
  [string]$Repo = "0xherstory/WWW6.5",
  [string]$TaskName = "PRAutoCheck15Min",
  [int]$IntervalMinutes = 15,
  [string]$ProjectRoot = "",
  [string]$WeekConfig = "prautocheck/week-config.example.json",
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"

if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 1439) {
  throw "IntervalMinutes must be between 1 and 1439."
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$runner = Join-Path $ProjectRoot "prautocheck\run-precheck-hourly.ps1"
if (-not (Test-Path -LiteralPath $runner)) {
  throw "Runner script not found: $runner"
}

$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Repo `"$Repo`" -ProjectRoot `"$ProjectRoot`" -WeekConfig `"$WeekConfig`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs

$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 30)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Host "Task created/updated: $TaskName"
Write-Host "Repo: $Repo"
Write-Host "WeekConfig: $WeekConfig"
Write-Host "Interval: every $IntervalMinutes minutes"
Write-Host ""
Write-Host "Check:"
Write-Host "  Get-ScheduledTask -TaskName `"$TaskName`" | Get-ScheduledTaskInfo"
Write-Host "Run once now:"
Write-Host "  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "Delete:"
Write-Host "  Unregister-ScheduledTask -TaskName `"$TaskName`" -Confirm:`$false"

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Triggered once immediately."
}
