$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$dataPath = Join-Path $projectRoot '.data'
New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
$stopPath = Join-Path $dataPath 'bridge-service.stop'
if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
while (!(Test-Path -LiteralPath $stopPath)) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $worker = Start-Process -FilePath $nodePath -ArgumentList @('--env-file-if-exists=.env', 'dist/bridge/main.js', 'bridge.config.json') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath "bridge-$stamp.out.log") -RedirectStandardError (Join-Path $dataPath "bridge-$stamp.err.log")
    $worker.WaitForExit()
    if (!(Test-Path -LiteralPath $stopPath)) { Start-Sleep -Seconds 5 }
}
