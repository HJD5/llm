$ErrorActionPreference = 'Stop'
$pidPath = Join-Path $PSScriptRoot 'platform\private-data\process.json'
if (Test-Path $pidPath) {
    $record = Get-Content $pidPath -Raw | ConvertFrom-Json
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($process -and $process.Path -eq $record.path -and $process.StartTime.ToUniversalTime().ToString('o') -eq $record.started) { Stop-Process -Id $process.Id }
}
Write-Host 'Platform stopped. Qwen has a separate stop-qwen.cmd.'
