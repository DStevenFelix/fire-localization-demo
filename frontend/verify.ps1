param([switch]$Browser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonExecutable = if ($env:FIRE_PYTHON) { $env:FIRE_PYTHON } else { 'D:/Anaconda/envs/agent/python.exe' }
if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw 'Anaconda agent Python missing; set FIRE_PYTHON to its python.exe' }
$localNode = Join-Path $PSScriptRoot '.tools/node-v24.21.0-win-x64'
if (Test-Path -LiteralPath (Join-Path $localNode 'node.exe')) { $env:Path = $localNode + ';' + $env:Path }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Run frontend/setup-node.ps1 first' }
$savedDotenv = $env:PYTHON_DOTENV_DISABLED
try {
    $env:PYTHON_DOTENV_DISABLED = '1'
    $env:PYTHONUTF8 = '1'
    $env:PYTHONPYCACHEPREFIX = Join-Path $PSScriptRoot '.tools/pycache'
    $env:LANGSMITH_TRACING = 'false'
    $env:LANGCHAIN_TRACING_V2 = 'false'
    Set-Location -LiteralPath $projectRoot
    New-Item -ItemType Directory -Path 'runtime/frontend' -Force | Out-Null
    $testRoot = Join-Path $projectRoot ('runtime/frontend/acceptance_' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $testRoot) { throw 'Refusing to overwrite an existing test directory' }
    & $pythonExecutable -m pytest tests frontend/bridge/tests -q -o cache_dir=frontend/.tools/pytest-cache --basetemp=$testRoot
    if ($LASTEXITCODE -ne 0) { throw 'Python tests failed' }
    & $pythonExecutable fire_poi/scripts/verify_package.py
    if ($LASTEXITCODE -ne 0) { throw 'Map package verification failed' }
    & (Join-Path $PSScriptRoot 'scripts/verify-protection.ps1')
    Set-Location -LiteralPath (Join-Path $PSScriptRoot 'web')
    foreach ($script in @('typecheck', 'build', 'test')) {
        & npm.cmd run $script
        if ($LASTEXITCODE -ne 0) { throw "Frontend $script failed" }
    }
    if ($Browser) {
        & npm.cmd run test:e2e
        if ($LASTEXITCODE -ne 0) { throw 'Browser acceptance failed' }
    }
} finally { $env:PYTHON_DOTENV_DISABLED = $savedDotenv }
