param([string]$ConfigPath = 'bridge.config.json', [string]$LauncherPath = '')
$ErrorActionPreference = 'Stop'
$relayRoot = Split-Path -Parent $PSScriptRoot
if (!$LauncherPath) { $LauncherPath = Join-Path $relayRoot 'dist/bridge/launcher-main.js' }
$LauncherPath = [IO.Path]::GetFullPath($LauncherPath)
$relayConfigFull = if ([IO.Path]::IsPathRooted($ConfigPath)) { [IO.Path]::GetFullPath($ConfigPath) } else { [IO.Path]::GetFullPath((Join-Path $relayRoot $ConfigPath)) }
if (!(Test-Path -LiteralPath $relayConfigFull) -or !(Test-Path -LiteralPath $LauncherPath)) { throw 'Build launcher and prepare bridge configuration first.' }
$relayUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$relayHash = [Security.Cryptography.SHA256]::Create()
try { $relaySuffix = ([BitConverter]::ToString($relayHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($relayConfigFull.ToLowerInvariant())))).Replace('-', '').Substring(0, 12) } finally { $relayHash.Dispose() }
$relayTaskName = 'AgentRelay-Launcher-' + $relaySuffix
$relayNode = (Get-Command node.exe -ErrorAction Stop).Source
$relayArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'launcher-service.ps1') + '" -ConfigPath "' + $relayConfigFull + '" -NodePath "' + $relayNode + '" -LauncherPath "' + $LauncherPath + '"'
$relayAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $relayArguments -WorkingDirectory $relayRoot
$relayTrigger = New-ScheduledTaskTrigger -AtLogOn -User $relayUser
$relayPrincipal = New-ScheduledTaskPrincipal -UserId $relayUser -LogonType Interactive -RunLevel Limited
$relaySettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$relayDescription = 'Agent Relay local preview launcher: ' + $relayConfigFull
$relayExisting = Get-ScheduledTask -TaskName $relayTaskName -ErrorAction SilentlyContinue
if ($relayExisting -and $relayExisting.Description -ne $relayDescription) { throw 'An unrelated scheduled task already uses this name.' }
if (!$relayExisting) { Register-ScheduledTask -TaskName $relayTaskName -Action $relayAction -Trigger $relayTrigger -Principal $relayPrincipal -Settings $relaySettings -Description $relayDescription | Out-Null }
New-Item -ItemType Directory -Force -Path (Join-Path $relayRoot '.data') | Out-Null
@{taskName=$relayTaskName;configPath=$relayConfigFull;launcherPath=$LauncherPath;nodePath=$relayNode}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $relayRoot '.data/launcher-service.json') -Encoding UTF8
Start-ScheduledTask -TaskName $relayTaskName
Write-Output "Local preview launcher enabled: $relayTaskName"
