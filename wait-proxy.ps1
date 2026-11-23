Add-Type -AssemblyName System.Net.Http -ErrorAction Stop

function Wait-CopilotProxy {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Headers,
        [int]$Port = 17688,
        [int]$TimeoutSeconds = 60,
        [int]$ProbeTimeoutSeconds = 5,
        [System.Diagnostics.Process]$ProxyProcess
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($ProxyProcess) {
            $ProxyProcess.Refresh()
            if ($ProxyProcess.HasExited) { throw 'Proxy terminal exited before becoming ready.' }
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -Headers $Headers -TimeoutSec $ProbeTimeoutSeconds -ErrorAction Stop
            if ($health.provider -ne 'github-copilot' -or $health.status -ne 'ok') {
                throw 'Unexpected local proxy health response.'
            }
            return $health
        } catch [System.Net.WebException] {
            if ($_.Exception.Response) { throw }
            Write-Verbose 'Proxy connection is not ready; retrying.'
        } catch [System.Net.Http.HttpRequestException] {
            if ($_.Exception.StatusCode) { throw }
            Write-Verbose 'Proxy connection is not ready; retrying.'
        } catch [System.OperationCanceledException] {
            Write-Verbose 'Proxy health probe timed out; retrying.'
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Proxy did not become ready within $TimeoutSeconds seconds; inspect its terminal."
}
