$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (!(Test-Path -LiteralPath 'node_modules/electron/dist/electron.exe')) { throw 'Run npm ci first to install the desktop runtime.' }
& node scripts/setup.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node node_modules/typescript/bin/tsc
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Start-Process -FilePath (Join-Path $projectRoot 'node_modules/electron/dist/electron.exe') -ArgumentList @('desktop/main.cjs') -WorkingDirectory $projectRoot -WindowStyle Normal
