[CmdletBinding()]
param(
  [string]$ComputerName = 'BLADERUNNER-PC',
  [string]$DestinationScriptPath = 'C:\Users\BladeRunner\Desktop\Script3\sql-stmast-bridge.py',
  [string]$PythonPath = 'C:\Users\BladeRunner\AppData\Local\Programs\Python\Python311\python.exe',
  [string]$Sku = '8626100145',
  [ValidateSet('today', 'yesterday', 'last_week', 'general')]
  [string]$SalesPeriod = 'yesterday',
  [System.Management.Automation.PSCredential]$Credential
)

# Deploys bridge + report catalogue to the same folder, then restarts only the
# process that currently owns the bridge port. It never reboots BLADERUNNER or SQL Server.
$ErrorActionPreference = 'Stop'
$sourceScript = Join-Path $PSScriptRoot 'sql-stmast-bridge.py'
$catalogueScript = Join-Path $PSScriptRoot 'sql_report_catalogue.py'
if (-not (Test-Path -LiteralPath $sourceScript)) {
  throw "Missing bridge source file: $sourceScript"
}
if (-not (Test-Path -LiteralPath $catalogueScript)) {
  throw "Missing report catalogue file: $catalogueScript"
}

$gitCommit = (git -C (Split-Path -Parent $PSScriptRoot) rev-parse --short=12 HEAD).Trim()
if (-not $gitCommit) { $gitCommit = 'not-stamped' }
$dirtyBridge = git -C (Split-Path -Parent $PSScriptRoot) status --porcelain -- scripts/sql-stmast-bridge.py scripts/sql_report_catalogue.py
if ($dirtyBridge) { $gitCommit = "$gitCommit-dirty" }
$buildDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$sessionParams = @{ ComputerName = $ComputerName; ErrorAction = 'Stop' }
if ($Credential) { $sessionParams.Credential = $Credential }
$session = New-PSSession @sessionParams

try {
  Write-Host "Copying self-contained bridge to $ComputerName..." -ForegroundColor Cyan
  Copy-Item -LiteralPath $sourceScript -Destination $DestinationScriptPath -ToSession $session -Force
  $destinationCatalogue = Join-Path (Split-Path -Parent $DestinationScriptPath) 'sql_report_catalogue.py'
  Copy-Item -LiteralPath $catalogueScript -Destination $destinationCatalogue -ToSession $session -Force

  $report = Invoke-Command -Session $session -ArgumentList @(
    $DestinationScriptPath, $destinationCatalogue, $PythonPath, $Sku, $SalesPeriod, $gitCommit, $buildDate
  ) -ScriptBlock {
    param($bridgePath, $cataloguePath, $pythonPath, $sku, $salesPeriod, $buildCommit, $buildDateUtc)

    $ErrorActionPreference = 'Stop'
    if (-not (Test-Path -LiteralPath $bridgePath)) {
      throw "Bridge copy missing: $bridgePath"
    }
    if (-not (Test-Path -LiteralPath $cataloguePath)) {
      throw "Report catalogue copy missing: $cataloguePath"
    }
    if (-not (Test-Path -LiteralPath $pythonPath)) {
      throw "Python not found: $pythonPath"
    }

    $bridgeDir = Split-Path -Parent $bridgePath
    $envFile = Join-Path (Split-Path -Parent $bridgeDir) '.env'
    if (-not (Test-Path -LiteralPath $envFile)) {
      throw "Bridge .env missing: $envFile"
    }

    $envLines = Get-Content -LiteralPath $envFile
    $keyLine = $envLines | Where-Object { $_ -match '^\s*STOCK_SQL_BRIDGE_KEY\s*=' } | Select-Object -First 1
    if (-not $keyLine) { throw "STOCK_SQL_BRIDGE_KEY missing from $envFile" }
    $bridgeKey = (($keyLine -split '=', 2)[1]).Trim().Trim('"').Trim("'")

    $port = 8765
    $portLine = $envLines | Where-Object { $_ -match '^\s*STOCK_SQL_BRIDGE_PORT\s*=' } | Select-Object -First 1
    if ($portLine -and (($portLine -split '=', 2)[1]).Trim() -match '^\d+$') {
      $port = [int](($portLine -split '=', 2)[1]).Trim()
    }

    # Stop only a process demonstrably running this bridge. Refuse to kill an
    # unknown process that happens to own the port.
    $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
      $commandLine = [string]$process.CommandLine
      if ($commandLine -notmatch [regex]::Escape((Split-Path -Leaf $bridgePath))) {
        throw "Port $port is owned by unexpected process PID $($listener.OwningProcess): $commandLine"
      }
      Stop-Process -Id $listener.OwningProcess -Force
    }
    Start-Sleep -Seconds 2

    # These environment values become part of the bridge child process and are
    # exposed through /version to identify the exact deployed build.
    $env:SQL_BRIDGE_BUILD_COMMIT = $buildCommit
    $env:SQL_BRIDGE_BUILD_DATE_UTC = $buildDateUtc
    Start-Process -FilePath $pythonPath -ArgumentList "`"$bridgePath`"" -WorkingDirectory $bridgeDir -WindowStyle Minimized

    $headers = @{ 'Content-Type' = 'application/json'; 'x-api-key' = $bridgeKey }
    $baseUrl = "http://127.0.0.1:$port"
    $deadline = (Get-Date).AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 500
      try {
        $version = Invoke-RestMethod -Uri "$baseUrl/version" -Method GET -Headers $headers -TimeoutSec 3
        break
      } catch {
        $lastError = $_
      }
    } while ((Get-Date) -lt $deadline)
    if (-not $version) { throw "Bridge did not become ready: $($lastError.Exception.Message)" }

    $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method GET -Headers $headers -TimeoutSec 10
    if ($health.status -ne 'healthy' -or $health.database -ne 'connected' -or -not $health.readOnly) {
      throw "/health failed validation"
    }

    $stmast = Invoke-RestMethod -Uri "$baseUrl/stmast" -Method POST -Headers $headers `
      -Body (@{ sku = $sku } | ConvertTo-Json -Compress) -TimeoutSec 20
    if (-not $stmast.row -or [string]$stmast.row.CODE -ne $sku) {
      throw "/stmast failed validation for SKU $sku"
    }

    $topSellers = Invoke-RestMethod -Uri "$baseUrl/top-sellers" -Method POST -Headers $headers `
      -Body (@{ period = $salesPeriod; scope = 'top_sellers'; limit = 5 } | ConvertTo-Json -Compress) -TimeoutSec 25
    if ($null -eq $topSellers.items) {
      throw "/top-sellers response has no items array"
    }

    $reports = Invoke-RestMethod -Uri "$baseUrl/reports" -Method GET -Headers $headers -TimeoutSec 10
    if (-not $reports.reports -or $reports.readOnly -ne $true) {
      throw "/reports failed validation"
    }

    $reportRun = Invoke-RestMethod -Uri "$baseUrl/reports/run" -Method POST -Headers $headers `
      -Body (@{
        reportId = 'inventory.product_lookup'
        params = @{ sku = $sku }
      } | ConvertTo-Json -Compress) -TimeoutSec 25
    if ($reportRun.meta.readOnly -ne $true -or $reportRun.meta.source -ne 'POSWINSQL') {
      throw "/reports/run failed readOnly validation"
    }
    if ($reportRun.schemaVersion -ne 'proto.sql-report.v1' -or $reportRun.engineVersion -ne '4.3.0') {
      throw "/reports/run failed v4.3 contract validation"
    }
    if (-not $reportRun.report.id) {
      throw "/reports/run failed validation"
    }

    [pscustomobject]@{
      Version = $version.version
      GitCommit = $version.gitCommit
      BuildDate = $version.buildDate
      Health = $health.status
      StmastCode = $stmast.row.CODE
      StmastPriceA = $stmast.row.PRICE_A
      StmastOnHand = $stmast.row.ONHAND
      TopSellerItems = @($topSellers.items).Count
      InvoiceHeaders = $topSellers.invoiceHeaderCount
      ReportCount = @($reports.reports).Count
      ReportRunId = $reportRun.report.id
    }
  }

  Write-Host 'PASS: /version, /health, /stmast, /top-sellers, /reports, /reports/run' -ForegroundColor Green
  $report | Format-List
} catch {
  Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
  throw
} finally {
  if ($session) { Remove-PSSession $session }
}
