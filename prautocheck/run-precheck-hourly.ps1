param(
  [string]$Repo = "0xherstory/WWW6.5",
  [string]$ProjectRoot = "",
  [string]$WeekConfig = "prautocheck/week-config.example.json"
)

$ErrorActionPreference = "SilentlyContinue"

# Force UTF-8 output in scheduled task sessions.
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
Set-Location $ProjectRoot

$exitCode = 0
$nodeOutput = @()
$psErrorMessage = $null
$psErrorStack = $null
$maxAttempts = 3
$retryDelaySeconds = 30
$attemptUsed = 1

function Test-TransientNetworkError {
  param(
    [int]$Code,
    [string[]]$Lines
  )
  if ($Code -eq 0) { return $false }
  $text = ($Lines -join "`n").ToLowerInvariant()
  return (
    $text.Contains("error connecting to api.github.com") -or
    $text.Contains("enotfound") -or
    $text.Contains("econnreset") -or
    $text.Contains("etimedout") -or
    $text.Contains("network") -or
    $text.Contains("timeout")
  )
}

try {
  $weekConfigArg = @()
  if (-not [string]::IsNullOrWhiteSpace($WeekConfig)) {
    $weekConfigArg = @("--week-config", $WeekConfig)
  }
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt += 1) {
    $attemptUsed = $attempt
    $nodeOutput = & node "prautocheck\pr-precheck.mjs" --repo $Repo --apply --yes @weekConfigArg 2>&1
    $exitCode = $LASTEXITCODE

    $attemptLines = @(
      foreach ($line in $nodeOutput) {
        if ($line -is [System.Management.Automation.ErrorRecord]) { $line.ToString() } else { [string]$line }
      }
    )
    $needRetry = Test-TransientNetworkError -Code $exitCode -Lines $attemptLines
    if (-not $needRetry -or $attempt -eq $maxAttempts) {
      break
    }
    Start-Sleep -Seconds $retryDelaySeconds
  }
} catch {
  $exitCode = 1
  $psErrorMessage = $_.Exception.Message
  $psErrorStack = $_.ScriptStackTrace
}

$outputLines = @(
  foreach ($line in $nodeOutput) {
    if ($line -is [System.Management.Automation.ErrorRecord]) {
      "[STDERR] $($line.ToString())"
    } else {
      [string]$line
    }
  }
)

$noOpenPr = ($exitCode -eq 0) -and (($outputLines | Where-Object { $_ -match "open PR.+:\s*0$" } | Measure-Object).Count -gt 0)
if ($noOpenPr) {
  Write-Host "No open PR to process, skip log file generation."
  exit 0
}

$logDir = Join-Path $ProjectRoot "prautocheck\reports\task-logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $logDir "pr-precheck-auto-$timestamp.log"
$summaryFile = Join-Path $logDir "latest-run.log"

function Write-Log {
  param([string]$Msg)
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

Write-Log "===== START repo=$Repo ====="
if (-not [string]::IsNullOrWhiteSpace($WeekConfig)) {
  Write-Log "Week config: $WeekConfig"
}
if ($attemptUsed -gt 1) {
  Write-Log "Network retry attempts used: $attemptUsed/$maxAttempts"
}

foreach ($text in $outputLines) {
  Add-Content -Path $logFile -Value $text -Encoding UTF8
  Write-Host $text
}
if ($exitCode -ne 0) {
  Write-Log "Node exited with code $exitCode (check lines above for details)"
}
if ($psErrorMessage) {
  Write-Log "[PS-ERROR] $psErrorMessage"
}
if ($psErrorStack) {
  Write-Log "[PS-ERROR] $psErrorStack"
}

$status = if ($exitCode -eq 0) { "SUCCESS" } else { "FAILED (exit=$exitCode)" }
Write-Log "===== END $status ====="

@"
last_run  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
repo      : $Repo
status    : $status
log_file  : $logFile
"@ | Set-Content -Path $summaryFile -Encoding UTF8

exit $exitCode
