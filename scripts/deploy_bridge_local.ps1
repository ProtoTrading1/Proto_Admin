[CmdletBinding()]
param(
  [string]$DestinationScriptPath = 'C:\Users\BladeRunner\Desktop\Script3\sql-stmast-bridge.py',
  [string]$PythonPath = 'C:\Users\BladeRunner\AppData\Local\Programs\Python\Python311\python.exe',
  [string]$Sku = '8626100145',
  [string]$ExpectedCommit = $env:GITHUB_SHA
)

# Runs only on BLADERUNNER-PC through its repository-scoped GitHub Actions
# runner. The bridge remains SELECT-only and its API key remains local in .env.
$ErrorActionPreference = 'Stop'

function Get-EnvValue {
  param([string[]]$Lines, [string]$Name)
  $match = $Lines | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -First 1
  if (-not $match) { return $null }
  return (($match -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

$sourceBridge = Join-Path $PSScriptRoot 'sql-stmast-bridge.py'
$sourceCatalogue = Join-Path $PSScriptRoot 'sql_report_catalogue.py'
foreach ($source in @($sourceBridge, $sourceCatalogue)) {
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing workflow source: $source" }
}
if (-not (Test-Path -LiteralPath $PythonPath)) { throw "Python was not found: $PythonPath" }
if ($Sku -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw 'SKU contains unsupported characters.' }

$bridgeDirectory = Split-Path -Parent $DestinationScriptPath
$destinationCatalogue = Join-Path $bridgeDirectory 'sql_report_catalogue.py'
$envFile = Join-Path (Split-Path -Parent $bridgeDirectory) '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw "Required bridge configuration is missing: $envFile" }

$envLines = Get-Content -LiteralPath $envFile
$bridgeKey = Get-EnvValue -Lines $envLines -Name 'STOCK_SQL_BRIDGE_KEY'
if ([string]::IsNullOrWhiteSpace($bridgeKey)) { throw "STOCK_SQL_BRIDGE_KEY is missing from $envFile" }
$portValue = Get-EnvValue -Lines $envLines -Name 'STOCK_SQL_BRIDGE_PORT'
$port = if ($portValue -match '^\d+$') { [int]$portValue } else { 8765 }
if ($port -lt 1 -or $port -gt 65535) { throw 'STOCK_SQL_BRIDGE_PORT is invalid.' }

$commit = if ([string]::IsNullOrWhiteSpace($ExpectedCommit)) { 'manual-local' } else { $ExpectedCommit.Substring(0, [Math]::Min(12, $ExpectedCommit.Length)) }
$buildDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

try {
  Write-Host "Deploying Apollo SQL bridge build $commit to local BLADERUNNER target..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $bridgeDirectory | Out-Null
  Copy-Item -LiteralPath $sourceBridge -Destination $DestinationScriptPath -Force
  Copy-Item -LiteralPath $sourceCatalogue -Destination $destinationCatalogue -Force

  # Refuse to stop an unrelated application that happens to use this port.
  $bridgeLeaf = Split-Path -Leaf $DestinationScriptPath
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $commandLine = [string]$process.CommandLine
    if ($commandLine -notmatch [regex]::Escape($bridgeLeaf)) {
      throw "Port $port belongs to an unexpected process (PID $($listener.OwningProcess)). Deployment stopped safely."
    }
    Stop-Process -Id $listener.OwningProcess -Force
  }
  Start-Sleep -Seconds 2

  $env:SQL_BRIDGE_BUILD_COMMIT = $commit
  $env:SQL_BRIDGE_BUILD_DATE_UTC = $buildDate
  Start-Process -FilePath $PythonPath -ArgumentList "`"$DestinationScriptPath`"" -WorkingDirectory $bridgeDirectory -WindowStyle Minimized

  $headers = @{ 'Content-Type' = 'application/json'; 'x-api-key' = $bridgeKey }
  $baseUrl = "http://127.0.0.1:$port"
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    try { $version = Invoke-RestMethod -Uri "$baseUrl/version" -Headers $headers -TimeoutSec 3; break }
    catch { $lastError = $_ }
  } while ((Get-Date) -lt $deadline)
  if (-not $version) { throw "Bridge did not become ready: $($lastError.Exception.Message)" }
  if ($version.version -ne '1.4.0' -or $version.reportSchemaVersion -ne 'proto.sql-report.v1' -or $version.reportEngineVersion -ne '4.3.0') {
    throw '/version did not return the required Apollo v4.3 bridge contract.'
  }

  $health = Invoke-RestMethod -Uri "$baseUrl/health" -Headers $headers -TimeoutSec 15
  if ($health.status -ne 'healthy' -or $health.database -ne 'connected' -or $health.readOnly -ne $true) {
    throw '/health did not confirm a healthy read-only POSWINSQL connection.'
  }
  $reports = Invoke-RestMethod -Uri "$baseUrl/reports" -Headers $headers -TimeoutSec 15
  if ($reports.readOnly -ne $true -or @($reports.reports).Count -ne 16) { throw '/reports did not return the 16 approved read-only reports.' }
  $lookup = Invoke-RestMethod -Uri "$baseUrl/reports/run" -Method POST -Headers $headers -TimeoutSec 25 -Body (@{
      reportId = 'inventory.product_lookup'; params = @{ sku = $Sku }
    } | ConvertTo-Json -Compress)
  if ($lookup.meta.readOnly -ne $true -or $lookup.meta.source -ne 'POSWINSQL' -or $lookup.report.id -ne 'inventory.product_lookup') {
    throw '/reports/run failed the read-only product lookup verification.'
  }

  Write-Host 'PASS: bridge copied, restarted, and verified against local POSWINSQL.' -ForegroundColor Green
  [pscustomobject]@{
    Build = $commit; Health = $health.status; ReportCount = @($reports.reports).Count; LookupReport = $lookup.report.id
  } | Format-List
} catch {
  Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
