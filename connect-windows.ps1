param([Parameter(Mandatory = $true)][string]$GitHubLogin)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'authenticate.mjs') --login $GitHubLogin
if ($LASTEXITCODE -ne 0) { throw 'GitHub authorization failed; proxy was not started.' }
$state = Join-Path $env:LOCALAPPDATA 'CopilotCodexProxy\state'
$key = [IO.File]::ReadAllText((Join-Path $state 'local-api-key')).Trim()
[Environment]::SetEnvironmentVariable('CODEX_COPILOT_PROXY_KEY', $key, 'User')
$env:CODEX_COPILOT_PROXY_KEY = $key
$headers = @{ Authorization = "Bearer $key" }
$listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 17688 -State Listen -ErrorAction SilentlyContinue
if (!$listener) {
    $startProxy = Join-Path $PSScriptRoot 'start-proxy.ps1'
    $process = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-NoExit', '-File', "`"$startProxy`"") -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        $process.Refresh()
        if ($process.HasExited) { throw 'Proxy terminal exited before becoming ready.' }
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:17688/health' -Headers $headers -TimeoutSec 2
            if ($health.provider -ne 'github-copilot') { throw 'Unexpected proxy identity.' }
            $ready = $true
            break
        } catch [System.Net.WebException] {
            if ($_.Exception.Response) { throw }
        } catch [System.Net.Http.HttpRequestException] {
            if ($_.Exception.StatusCode) { throw }
        }
    }
    if (!$ready) { throw 'Proxy did not become ready; inspect its terminal.' }
}
& (Join-Path $PSScriptRoot 'start-codex.ps1')
