param(
  [switch]$Install
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot '.runtime'
$pidFile = Join-Path $runtimeDir 'dev-pids.json'

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Get-CommandPath {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Missing required command: $Name"
  }
  return $cmd.Source
}

function Stop-PortOwnerIfNeeded {
  param(
    [int]$Port,
    [string]$Label
  )
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    try {
      Stop-Process -Id $listener.OwningProcess -ErrorAction Stop
      Write-Host "[dev-start] Stopped existing $Label process on port $Port (PID $($listener.OwningProcess))"
    } catch {
      Write-Warning "[dev-start] Failed to stop existing $Label process on port $Port (PID $($listener.OwningProcess)): $($_.Exception.Message)"
    }
  }
}

function Start-ManagedProcess {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  if (Test-Path -LiteralPath $StdoutPath) {
    Remove-Item -LiteralPath $StdoutPath -Force
  }
  if (Test-Path -LiteralPath $StderrPath) {
    Remove-Item -LiteralPath $StderrPath -Force
  }

  $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -WindowStyle Hidden -PassThru
  Write-Host "[dev-start] Started $Name (PID $($proc.Id))"
  return $proc.Id
}

Ensure-Directory $runtimeDir

if ($Install) {
  & (Get-CommandPath 'pnpm') '-w' 'install'
}

$pnpmPath = Get-CommandPath 'pnpm'
$goPath = 'C:\Program Files\Go\bin\go.exe'
if (-not (Test-Path -LiteralPath $goPath)) {
  throw 'Go not found at C:\Program Files\Go\bin\go.exe'
}

Stop-PortOwnerIfNeeded -Port 4455 -Label 'new-api'
Stop-PortOwnerIfNeeded -Port 8788 -Label 'hono-api'
Stop-PortOwnerIfNeeded -Port 5173 -Label 'web'
Stop-PortOwnerIfNeeded -Port 8799 -Label 'agents-bridge'

$newApiPid = Start-ManagedProcess -Name 'new-api' -FilePath $goPath -ArgumentList @('run', '.') -WorkingDirectory (Join-Path $repoRoot 'apps\new-api') -StdoutPath (Join-Path $repoRoot 'new-api.dev.log') -StderrPath (Join-Path $repoRoot 'new-api.dev.err.log')

Start-Sleep -Seconds 5

$apiPid = Start-ManagedProcess -Name 'hono-api' -FilePath $pnpmPath -ArgumentList @('--filter', '@tapcanvas/api', 'start') -WorkingDirectory $repoRoot -StdoutPath (Join-Path $repoRoot 'api.start.log') -StderrPath (Join-Path $repoRoot 'api.start.err.log')

$webPid = Start-ManagedProcess -Name 'web' -FilePath $pnpmPath -ArgumentList @('--filter', '@tapcanvas/web', 'dev') -WorkingDirectory $repoRoot -StdoutPath (Join-Path $repoRoot 'web.dev.log') -StderrPath (Join-Path $repoRoot 'web.dev.err.log')

$pidState = [ordered]@{
  newApi = $newApiPid
  api = $apiPid
  web = $webPid
  startedAt = (Get-Date).ToString('o')
}
$pidState | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

Write-Host '[dev-start] Runtime started:'
Write-Host '  Web:     http://localhost:5173'
Write-Host '  API:     http://localhost:8788'
Write-Host '  new-api: http://localhost:4455'
Write-Host "[dev-start] PID file: $pidFile"
