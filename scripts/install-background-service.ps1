param([string]$ConfigPath = 'bridge.config.json')
$ErrorActionPreference = 'Stop'
$relayRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $relayRoot
$relayConfigFull = if ([IO.Path]::IsPathRooted($ConfigPath)) { [IO.Path]::GetFullPath($ConfigPath) } else { [IO.Path]::GetFullPath((Join-Path $relayRoot $ConfigPath)) }
if (!(Test-Path -LiteralPath $relayConfigFull)) { throw 'Bridge configuration does not exist.' }
if (!(Test-Path -LiteralPath (Join-Path $relayRoot 'dist/bridge/main.js'))) { throw 'Build Agent Relay before installing the background service.' }
$relayUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$relayHash = [Security.Cryptography.SHA256]::Create()
try { $relaySuffix = ([BitConverter]::ToString($relayHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($relayConfigFull.ToLowerInvariant())))).Replace('-', '').Substring(0, 12) } finally { $relayHash.Dispose() }
$relayTaskName = 'AgentRelay-' + $relaySuffix
$relayScript = Join-Path $PSScriptRoot 'background-service.ps1'
$relayNode = (Get-Command node.exe -ErrorAction Stop).Source
$relayArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $relayScript + '" -ConfigPath "' + $relayConfigFull + '" -NodePath "' + $relayNode + '"'
$relayAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $relayArguments -WorkingDirectory $relayRoot
$relayTrigger = New-ScheduledTaskTrigger -AtLogOn -User $relayUser
$relayPrincipal = New-ScheduledTaskPrincipal -UserId $relayUser -LogonType Interactive -RunLevel Limited
$relaySettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$relayDescription = 'Agent Relay independent background supervisor: ' + $relayConfigFull
$relayExisting = Get-ScheduledTask -TaskName $relayTaskName -ErrorAction SilentlyContinue
if ($relayExisting -and $relayExisting.Description -ne $relayDescription) { throw 'An unrelated scheduled task already uses this name.' }
if (!$relayExisting) {
    Register-ScheduledTask -TaskName $relayTaskName -Action $relayAction -Trigger $relayTrigger -Principal $relayPrincipal -Settings $relaySettings -Description $relayDescription | Out-Null
}
$relayData = Join-Path $relayRoot '.data'
New-Item -ItemType Directory -Force -Path $relayData | Out-Null
$relayStop = Join-Path $relayData 'background-service.stop'
if (Test-Path -LiteralPath $relayStop) { Remove-Item -LiteralPath $relayStop }
Start-ScheduledTask -TaskName $relayTaskName
@{ taskName = $relayTaskName; configPath = $relayConfigFull; user = $relayUser } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $relayData 'background-service.json') -Encoding UTF8
Write-Output "Agent Relay background service enabled: $relayTaskName"
