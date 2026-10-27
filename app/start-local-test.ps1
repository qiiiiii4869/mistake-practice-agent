$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskService = Join-Path $taskRoot 'server'
$taskLogs = Join-Path $taskRoot 'tmp'
try { $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2 } catch { $taskHealth = $null }
if (-not $taskHealth.ok) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskService 'node_modules'))) { throw 'Run npm --prefix server ci first.' }
    New-Item -ItemType Directory -Force -Path $taskLogs | Out-Null
    Start-Process -FilePath (Get-Command node).Source -ArgumentList @('src/index.mjs') -WorkingDirectory $taskService -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs 'account-server.stdout.log') -RedirectStandardError (Join-Path $taskLogs 'account-server.stderr.log')
    $taskReady = $false
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        try { $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 1; if ($taskHealth.ok) { $taskReady = $true; break } } catch {}
        Start-Sleep -Milliseconds 200
    }
    if (-not $taskReady) { throw 'Local account server failed to start. Check tmp/account-server.stderr.log.' }
}
& (Join-Path $PSScriptRoot 'start-windows.ps1')
Write-Output 'Local test is ready. Admin page: http://127.0.0.1:8787/admin'
