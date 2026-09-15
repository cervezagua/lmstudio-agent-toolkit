<#
.SYNOPSIS
  Starts the WSL SearXNG instance and keeps it reachable at http://localhost:8888.

.DESCRIPTION
  WSL stops a distro a few seconds after its last session closes, which also stops the SearXNG
  systemd service. This script starts the service and one hidden, idle WSL session ("keepalive")
  so the distro and SearXNG stay up, then waits until SearXNG answers. Running it again is harmless.

  From Explorer, double-click start-searxng.cmd instead: Windows PowerShell's default execution
  policy blocks .ps1 files, including "Run with PowerShell".

  Stop SearXNG with:  .\start-searxng.ps1 -Stop   (or stop-searxng.cmd)
#>
param(
  [string]$Distro = "Ubuntu",
  [int]$Port = 8888,
  [int]$TimeoutSeconds = 90,
  [switch]$Stop
)

$marker = "searxng-keepalive"
$healthUrl = "http://localhost:$Port/healthz"

function Test-SearXNG {
  try { (Invoke-WebRequest $healthUrl -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200 } catch { $false }
}

function Get-Keepalive {
  Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Where-Object { $_.CommandLine -match $marker }
}

function Invoke-Wsl([string[]]$Command) {
  # wsl.exe writes UTF-16 on its own errors; capture everything as text for readable messages.
  $output = & wsl.exe -d $Distro -u root -- @Command 2>&1 | Out-String
  return @{ ExitCode = $LASTEXITCODE; Output = ($output -replace "`0", "").Trim() }
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  Write-Error "WSL is not installed (wsl.exe not found)."
  exit 1
}

if ($Stop) {
  Get-Keepalive | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $result = Invoke-Wsl @("systemctl", "stop", "searxng")
  if ($result.ExitCode -ne 0) { Write-Warning "systemctl stop searxng: $($result.Output)" }
  Write-Output "SearXNG stopped. WSL will shut the distro down once no other sessions are open."
  exit 0
}

# Starting the service also boots the distro if it is stopped. Doing it explicitly (rather than
# relying on the unit being enabled) recovers from a service that was stopped or crashed.
$result = Invoke-Wsl @("systemctl", "start", "searxng")
if ($result.ExitCode -ne 0) {
  if ($result.Output -match "not found|no such unit") {
    Write-Error "The searxng service is not installed in WSL distro '$Distro'. Run this from the '$PSScriptRoot' folder:  wsl -d $Distro -u root -- bash ./setup-wsl.sh"
  } else {
    Write-Error "Could not start SearXNG in WSL distro '$Distro' (exit $($result.ExitCode)): $($result.Output)"
  }
  exit 1
}

if (-not (Get-Keepalive)) {
  # The marker only appears in the command line so this script can find the process again.
  Start-Process wsl.exe -WindowStyle Hidden -ArgumentList @(
    "-d", $Distro, "-u", "root", "--", "bash", "-c", "`"exec sleep infinity # $marker`""
  )
}

$deadline = [Diagnostics.Stopwatch]::StartNew()
while ($deadline.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
  if (Test-SearXNG) {
    Write-Output "SearXNG is running at http://localhost:$Port"
    exit 0
  }
  Start-Sleep -Seconds 1
}

$status = Invoke-Wsl @("systemctl", "is-active", "searxng")
Write-Error ("SearXNG did not respond on port $Port within $TimeoutSeconds seconds (service state: $($status.Output)). " +
  "Check the logs with:  wsl -d $Distro -u root -- journalctl -u searxng -n 50 --no-pager")
exit 1
