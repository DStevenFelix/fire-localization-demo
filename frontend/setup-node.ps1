$ErrorActionPreference = 'Stop'
$nodeVersion = '24.21.0'
$toolsPath = Join-Path $PSScriptRoot '.tools'
$nodePath = Join-Path $toolsPath "node-v$nodeVersion-win-x64"
New-Item -ItemType Directory -Path $toolsPath -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $nodePath 'node.exe'))) {
    $archiveName = "node-v$nodeVersion-win-x64.zip"
    $archivePath = Join-Path $toolsPath $archiveName
    $checksumPath = Join-Path $toolsPath 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile $checksumPath
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/$archiveName" -OutFile $archivePath
    $checksumLine = Get-Content -LiteralPath $checksumPath | Where-Object { $_.EndsWith(" $archiveName") }
    if (-not $checksumLine) { throw 'Official SHA-256 record missing' }
    $expectedHash = ($checksumLine -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLower() -ne $expectedHash) {
        throw 'Node archive SHA-256 mismatch'
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolsPath
}
$env:Path = $nodePath + ';' + $env:Path
$env:npm_config_cache = Join-Path $toolsPath 'npm-cache'
& (Join-Path $nodePath 'node.exe') --version
& (Join-Path $nodePath 'npm.cmd') --version
Set-Location -LiteralPath (Join-Path $PSScriptRoot 'web')
& (Join-Path $nodePath 'npm.cmd') ci --no-audit --no-fund
exit $LASTEXITCODE
