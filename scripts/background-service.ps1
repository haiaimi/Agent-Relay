param([string]$ConfigPath = 'bridge.config.json', [string]$NodePath = '')
$ErrorActionPreference = 'Stop'
$relayRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $relayRoot
$ConfigPath = if ([IO.Path]::IsPathRooted($ConfigPath)) { [IO.Path]::GetFullPath($ConfigPath) } else { [IO.Path]::GetFullPath((Join-Path $relayRoot $ConfigPath)) }
if (!$NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$relayData = Join-Path $relayRoot '.data'
New-Item -ItemType Directory -Force -Path $relayData | Out-Null
$relayKey = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ConfigPath.ToLowerInvariant())).Replace('/', '_')
$relayMutex = New-Object Threading.Mutex($false, ('Local\AgentRelay-' + $relayKey))
if (!$relayMutex.WaitOne(0)) { $relayMutex.Dispose(); exit 0 }
$relayStop = Join-Path $relayData 'background-service.stop'
$relayLog = Join-Path $relayData 'background-service.log'
function Write-RelayLog([string]$Message) { Add-Content -LiteralPath $relayLog -Value ((Get-Date -Format o) + ' ' + $Message) }
function Get-RelayWorker([string]$Path) {
    $relayConfig = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $relayStore = if ($relayConfig.dataDir) { $relayConfig.dataDir } else { '.data/bridge' }
    if (![IO.Path]::IsPathRooted($relayStore)) { $relayStore = Join-Path $relayRoot $relayStore }
    try {
        $relayWorkerPid = [int](Get-Content -LiteralPath (Join-Path $relayStore 'bridge.lock') -Raw)
        $relayWorker = Get-CimInstance Win32_Process -Filter "ProcessId=$relayWorkerPid"
        # Validate PID ownership before adopting it; a stale PID may have been reused.
        if ($relayWorker.Name -eq 'node.exe' -and $relayWorker.CommandLine -match 'dist[\\/]bridge[\\/]main\.js' -and $relayWorker.CommandLine.Contains([IO.Path]::GetFileName($Path))) { return $relayWorkerPid }
    } catch {}
    return $null
}
try {
    Write-RelayLog "Supervisor started PID=$PID"
    while (!(Test-Path -LiteralPath $relayStop)) {
        $relayConfigs = @($ConfigPath)
        $relayBrain = Join-Path $relayData 'brainstorm-bridge.config.json'
        if (Test-Path -LiteralPath $relayBrain) { $relayConfigs += $relayBrain }
        foreach ($relayWorkerConfig in $relayConfigs) {
            if (Get-RelayWorker $relayWorkerConfig) { continue }
            $relayLabel = if ($relayWorkerConfig -eq $ConfigPath) { 'service-bridge' } else { 'service-brainstorm' }
            $relayStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
            # Task Scheduler owns this process tree, independently of desktop windows and Codex.
            $relayChild = Start-Process -FilePath $NodePath -ArgumentList @('--env-file-if-exists=.env', 'dist/bridge/main.js', ('"' + $relayWorkerConfig + '"')) -WorkingDirectory $relayRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $relayData "$relayLabel-$relayStamp.out.log") -RedirectStandardError (Join-Path $relayData "$relayLabel-$relayStamp.err.log")
            Write-RelayLog "Started $relayLabel PID=$($relayChild.Id)"
        }
        Start-Sleep -Seconds 3
    }
} finally {
    Write-RelayLog 'Supervisor stopped; existing workers left running'
    $relayMutex.ReleaseMutex(); $relayMutex.Dispose()
}
