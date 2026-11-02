$ErrorActionPreference = 'Stop'
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = @{}
foreach ($item in $items) {
    if (!(Test-Path -LiteralPath $item.path -PathType Leaf)) { continue }
    $stream = $null
    try {
        $stream = [System.IO.File]::Open($item.path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        $stream.Lock(0, 1)
        $stream.Unlock(0, 1)
        $result[$item.id] = $false
    } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        $code = $failure.HResult -band 0xFFFF
        if ($code -eq 33) { $result[$item.id] = $true }
    } finally { if ($stream) { $stream.Dispose() } }
}
$result | ConvertTo-Json -Compress
