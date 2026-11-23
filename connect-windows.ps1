param([Parameter(Mandatory = $true)][string]$GitHubLogin)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wait-proxy.ps1')
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'authenticate.mjs') --login $GitHubLogin
if ($LASTEXITCODE -ne 0) { throw 'GitHub authorization failed; proxy was not started.' }
$state = Join-Path $env:LOCALAPPDATA 'CopilotCodexProxy\state'
$key = [IO.File]::ReadAllText((Join-Path $state 'local-api-key')).Trim()
[Environment]::SetEnvironmentVariable('CODEX_COPILOT_PROXY_KEY', $key, 'User')
$env:CODEX_COPILOT_PROXY_KEY = $key
$headers = @{ Authorization = "Bearer $key" }
$listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 17688 -State Listen -ErrorAction SilentlyContinue
$process = $null
if (!$listener) {
    $startProxy = Join-Path $PSScriptRoot 'start-proxy.ps1'
    $process = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-NoExit', '-File', "`"$startProxy`"") -PassThru
}
$null = Wait-CopilotProxy -Headers $headers -ProxyProcess $process
& (Join-Path $PSScriptRoot 'start-codex.ps1')
