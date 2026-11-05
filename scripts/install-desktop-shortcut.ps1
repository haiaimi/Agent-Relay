$ErrorActionPreference = 'Stop'
$relayProjectRoot = Split-Path -Parent $PSScriptRoot
$relayDesktopFolder = [Environment]::GetFolderPath('Desktop')
$relayShortcutPath = Join-Path $relayDesktopFolder 'Agent Relay 游戏工作室.lnk'
$relayShell = New-Object -ComObject WScript.Shell
$relayShortcut = $relayShell.CreateShortcut($relayShortcutPath)
$relayLauncher = Join-Path $PSScriptRoot 'start-desktop.ps1'
if ((Test-Path -LiteralPath $relayShortcutPath) -and $relayShortcut.Arguments -notlike "*$relayLauncher*") { throw 'An unrelated shortcut already uses this name.' }
$relayShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$relayShortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $relayLauncher + '"'
$relayShortcut.WorkingDirectory = $relayProjectRoot
$relayShortcut.IconLocation = (Join-Path $relayProjectRoot 'node_modules\electron\dist\electron.exe') + ',0'
$relayShortcut.Description = '游戏团队、Agent 模型与工程路径管理'
$relayShortcut.Save()
Write-Output $relayShortcutPath
