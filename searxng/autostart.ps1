<#
.SYNOPSIS
  Registers (or removes, with -Remove) a per-user scheduled task that runs start-searxng.ps1 at logon.

.DESCRIPTION
  The task runs as the current user, needs no admin rights, and only starts WSL + SearXNG. It
  does not change WSL's global settings.
#>
param([switch]$Remove)

$taskName = "SearXNG for LM Studio (WSL)"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Removed scheduled task '$taskName'."
  exit 0
}

$script = Join-Path $PSScriptRoot "start-searxng.ps1"
$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
$shell = if ($pwsh) { $pwsh.Source } else { "powershell.exe" }

$action = New-ScheduledTaskAction -Execute $shell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Starts the local SearXNG instance in WSL for the LM Studio web-tools plugin." -Force | Out-Null
Write-Output "Registered scheduled task '$taskName' (runs at logon). Remove it with: .\autostart.ps1 -Remove"
