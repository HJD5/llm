$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
try {
    $state = Invoke-RestMethod 'http://127.0.0.1:8090/api/bootstrap' -TimeoutSec 2
    if ($state.csrf -and $state.modules) { Write-Host 'Qazaq Loc QA is already running: http://127.0.0.1:8090'; exit 0 }
} catch {}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$data = Join-Path $root 'platform\private-data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$process = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $root 'platform\server.mjs') + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'platform.log') -RedirectStandardError (Join-Path $data 'platform-error.log') -PassThru
@{id=$process.Id; started=$process.StartTime.ToUniversalTime().ToString('o'); path=$node} | ConvertTo-Json | Set-Content (Join-Path $data 'process.json')
Write-Host 'Qazaq Loc QA is starting: http://127.0.0.1:8090'
Write-Host 'Open this address in your browser. Qwen can be started from the left panel.'
