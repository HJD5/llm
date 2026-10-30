$pidFile = Join-Path $PSScriptRoot 'server.pid'
if (Test-Path $pidFile) {
    $serverProcessId = [int](Get-Content $pidFile)
    $process = Get-Process -Id $serverProcessId -ErrorAction SilentlyContinue
    $expectedPath = Join-Path $PSScriptRoot 'runtime\llama-server.exe'
    if ($process -and $process.Path -eq $expectedPath) { Stop-Process -Id $serverProcessId }
    Remove-Item -LiteralPath $pidFile
}
