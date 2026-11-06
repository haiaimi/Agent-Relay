param([string]$ConfigPath = 'bridge.config.json', [string]$NodePath = '', [string]$LauncherPath = '')
$ErrorActionPreference = 'Stop'
$relayRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $relayRoot
if (!$LauncherPath) { $LauncherPath = Join-Path $relayRoot 'dist/bridge/launcher-main.js' }
if (!$NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$relayData = Join-Path $relayRoot '.data'
New-Item -ItemType Directory -Force -Path $relayData | Out-Null
$relayStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$relayChild = Start-Process -FilePath $NodePath -ArgumentList @('--env-file-if-exists=.env', ('"' + $LauncherPath + '"'), ('"' + $ConfigPath + '"')) -WorkingDirectory $relayRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $relayData "launcher-$relayStamp.out.log") -RedirectStandardError (Join-Path $relayData "launcher-$relayStamp.err.log")
$relayChild.WaitForExit()
exit $relayChild.ExitCode
