$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'CopilotCodexProxy\state'
$env:CODEX_COPILOT_PROXY_KEY = [IO.File]::ReadAllText((Join-Path $state 'local-api-key')).Trim()
$headers = @{ Authorization = "Bearer $env:CODEX_COPILOT_PROXY_KEY" }
$health = Invoke-RestMethod 'http://127.0.0.1:17688/health' -Headers $headers -TimeoutSec 5
if ($health.provider -ne 'github-copilot') { throw 'Unexpected local proxy health response.' }
$package = Get-AppxPackage 'OpenAI.Codex' | Select-Object -First 1
if (!$package) { throw 'Codex Desktop is not installed for this Windows user.' }
$manifest = Get-AppxPackageManifest -Package $package.PackageFullName
$application = $manifest.Package.Applications.Application | Where-Object Id -eq 'App'
if (!$application) { throw 'Codex Desktop entry point could not be located.' }
$app = Join-Path $package.InstallLocation ($application.Executable -replace '/', '\')
if (!(Test-Path $app)) { throw 'Codex Desktop executable could not be located.' }
if (Get-Process -ErrorAction SilentlyContinue | Where-Object Path -eq $app) {
    throw 'Fully quit Codex Desktop before running this launcher so it can inherit the local proxy key.'
}
Start-Process -FilePath $app
