$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonExecutable = if ($env:FIRE_PYTHON) { $env:FIRE_PYTHON } else { 'D:/Anaconda/envs/agent/python.exe' }
if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw 'Anaconda agent Python is missing; set FIRE_PYTHON to the confirmed interpreter' }
$env:PYTHONUTF8 = '1'
$env:PYTHONPYCACHEPREFIX = Join-Path $PSScriptRoot '.tools/pycache'
$env:LANGSMITH_TRACING = 'false'
$env:LANGCHAIN_TRACING_V2 = 'false'
Set-Location -LiteralPath $projectRoot
& $pythonExecutable -m uvicorn frontend.bridge.server:app --app-dir $projectRoot --host 127.0.0.1 --port 8080
exit $LASTEXITCODE
