param([string]$ConfigPath = 'bridge.config.json')
$ErrorActionPreference = 'Stop'
# Task Scheduler owns the workers independently of the launching window.
& (Join-Path $PSScriptRoot 'install-background-service.ps1') -ConfigPath $ConfigPath
