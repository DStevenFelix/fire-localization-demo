$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localNode = Join-Path $PSScriptRoot '.tools/node-v24.21.0-win-x64'
if (Test-Path -LiteralPath (Join-Path $localNode 'node.exe')) {
    $env:Path = $localNode + ';' + $env:Path
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Node/npm is missing. See frontend/README.md for the portable Node setup.'
}
Set-Location -LiteralPath (Join-Path $PSScriptRoot 'web')
& npm.cmd run dev
exit $LASTEXITCODE
