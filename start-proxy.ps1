param([int]$Port = 17688)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'server.mjs') --port $Port
exit $LASTEXITCODE
