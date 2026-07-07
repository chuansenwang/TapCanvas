$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot '.runtime'
$pidFile = Join-Path $runtimeDir 'dev-pids.json'

function Stop-ManagedPid {
  param(
    [Nullable[int]]$Pid,
    [string]$Name
  )

  if (-not $Pid) {
    return
  }

  $proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue
  if ($proc) {
    try {
      Stop-Process -Id $Pid -ErrorAction Stop
      Write-Host "[dev-stop] Stopped $Name (PID $Pid)"
    } catch {
      Write-Warning "[dev-stop] Failed to stop $Name (PID $Pid): $($_.Exception.Message)"
    }
  }
}

function Stop-PortOwnerIfPresent {
  param(
    [int]$Port,
    [string]$Label
  )

  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    try {
      Stop-Process -Id $listener.OwningProcess -ErrorAction Stop
      Write-Host "[dev-stop] Stopped $Label process on port $Port (PID $($listener.OwningProcess))"
    } catch {
      Write-Warning "[dev-stop] Failed to stop $Label process on port $Port (PID $($listener.OwningProcess)): $($_.Exception.Message)"
    }
  }
}

if (Test-Path -LiteralPath $pidFile) {
  $state = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
  Stop-ManagedPid -Pid $state.web -Name 'web'
  Stop-ManagedPid -Pid $state.api -Name 'hono-api'
  Stop-ManagedPid -Pid $state.newApi -Name 'new-api'
  Remove-Item -LiteralPath $pidFile -Force
}

Stop-PortOwnerIfPresent -Port 5173 -Label 'web'
Stop-PortOwnerIfPresent -Port 8788 -Label 'hono-api'
Stop-PortOwnerIfPresent -Port 4455 -Label 'new-api'
Stop-PortOwnerIfPresent -Port 8799 -Label 'agents-bridge'

Write-Host '[dev-stop] Runtime stopped.'
