$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$server = Join-Path $root 'runtime\llama-server.exe'
$model = Join-Path $root 'models\Qwen3-8B-Q4_K_M.gguf'
$url = 'http://127.0.0.1:8088'
try {
    $health = Invoke-RestMethod "$url/health" -TimeoutSec 2
    if ($health.status -eq 'ok') { Write-Host "Server already running: $url"; exit 0 }
} catch {}
if (!(Test-Path $server) -or !(Test-Path $model)) { throw 'Runtime or model is missing.' }
if ((Get-Item $model).Length -ne 5027783488) { throw 'Model download is incomplete. Expected 5027783488 bytes.' }
$arguments = '-m "' + $model + '" --host 127.0.0.1 --port 8088 -c 4096 -np 1 -ngl 0 --reasoning off'
$process = Start-Process -FilePath $server -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'server.log') -RedirectStandardError (Join-Path $root 'server-error.log') -PassThru
$process.Id | Set-Content (Join-Path $root 'server.pid')
Write-Host "Qwen3-8B is loading. Open $url in your browser."
Write-Host 'Startup may take several minutes. Logs: server-error.log'
