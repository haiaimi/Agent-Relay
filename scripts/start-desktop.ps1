$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (!(Test-Path -LiteralPath 'node_modules/electron/dist/electron.exe')) { throw 'Run npm ci first to install the desktop runtime.' }
& node scripts/setup.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node node_modules/typescript/bin/tsc
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$relayDesktopNodeMode = $env:ELECTRON_RUN_AS_NODE
& (Join-Path $PSScriptRoot 'install-background-service.ps1')
try {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath (Join-Path $projectRoot 'node_modules/electron/dist/electron.exe') -ArgumentList @('desktop/main.cjs') -WorkingDirectory $projectRoot -WindowStyle Normal
} finally {
  if ($null -ne $relayDesktopNodeMode) { $env:ELECTRON_RUN_AS_NODE = $relayDesktopNodeMode }
}
