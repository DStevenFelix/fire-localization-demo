$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonExecutable = if ($env:FIRE_PYTHON) { $env:FIRE_PYTHON } else { Join-Path $projectRoot '.venv/Scripts/python.exe' }
if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw 'Project Python missing; create .venv or set FIRE_PYTHON to an existing python.exe' }
$env:PYTHONUTF8 = '1'
$env:PYTHONPYCACHEPREFIX = Join-Path $PSScriptRoot '.tools/pycache'
$env:LANGSMITH_TRACING = 'false'
$env:LANGCHAIN_TRACING_V2 = 'false'
Set-Location -LiteralPath $projectRoot
& $pythonExecutable -m uvicorn frontend.bridge.server:app --host 127.0.0.1 --port 8080
exit $LASTEXITCODE
