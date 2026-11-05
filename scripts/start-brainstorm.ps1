$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$configPath = Join-Path $projectRoot '.data/brainstorm-bridge.config.json'
if (!(Test-Path -LiteralPath $configPath)) { exit 0 }
$dataPath = Join-Path $projectRoot '.data'
$guardianLock = Join-Path $dataPath 'brainstorm-service.lock'
try {
    $stream = [System.IO.File]::Open($guardianLock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
} catch {
    $existingPid = 0
    try { $existingPid = [int](Get-Content -LiteralPath $guardianLock -Raw) } catch {}
    if ($existingPid -gt 0 -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) { exit 0 }
    Remove-Item -LiteralPath $guardianLock -ErrorAction SilentlyContinue
    $stream = [System.IO.File]::Open($guardianLock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
}
$writer = New-Object System.IO.StreamWriter($stream)
$writer.Write([string]$PID)
$writer.Dispose()
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
try {
    while (!(Test-Path -LiteralPath (Join-Path $dataPath 'brainstorm-service.stop'))) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $worker = Start-Process -FilePath $nodePath -ArgumentList @('--env-file-if-exists=.env', 'dist/bridge/main.js', '.data/brainstorm-bridge.config.json') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath "brainstorm-$stamp.out.log") -RedirectStandardError (Join-Path $dataPath "brainstorm-$stamp.err.log")
        $worker.WaitForExit()
        if (!(Test-Path -LiteralPath (Join-Path $dataPath 'brainstorm-service.stop'))) { Start-Sleep -Seconds 5 }
    }
} finally { Remove-Item -LiteralPath $guardianLock -ErrorAction SilentlyContinue }
