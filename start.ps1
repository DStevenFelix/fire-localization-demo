$ErrorActionPreference = 'Stop'

$python = if ($env:FIRE_PYTHON) { $env:FIRE_PYTHON } else { Join-Path $PSScriptRoot '.venv/Scripts/python.exe' }
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'Python not found. Set FIRE_PYTHON to your python.exe or prepare .venv as described in README.md.'
}
$python = (Resolve-Path -LiteralPath $python).Path

$node = Join-Path $PSScriptRoot 'frontend/.tools/node-v24.21.0-win-x64/node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    $node = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw 'Node.js not found. See README.md or run frontend/setup-node.ps1.' }
}
$webRoot = Join-Path $PSScriptRoot 'frontend/web'
if (-not (Test-Path -LiteralPath (Join-Path $webRoot 'node_modules/vite/bin/vite.js') -PathType Leaf)) {
    throw 'Frontend dependencies are missing. Run npm.cmd --prefix frontend/web ci.'
}

$services = @(
    @{ Name = 'SocialNet post source'; Port = 8000; File = $python; Arguments = '-m uvicorn socialnet.app.post_source:app --host 127.0.0.1 --port 8000'; Directory = $PSScriptRoot }
    @{ Name = 'Localization Bridge'; Port = 8080; File = $python; Arguments = '-m uvicorn frontend.bridge.server:app --host 127.0.0.1 --port 8080'; Directory = $PSScriptRoot }
    @{ Name = 'Fire web'; Port = 5173; File = $node; Arguments = 'node_modules/vite/bin/vite.js --configLoader native --clearScreen false'; Directory = $webRoot }
)
$network = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
$occupied = $network.GetActiveTcpListeners().Port | Where-Object { $_ -in $services.Port } | Sort-Object -Unique
if ($occupied) { throw "Required ports are already in use: $($occupied -join ', '). Stop the existing services before starting." }

$started = @()
$previousPythonUtf8 = $env:PYTHONUTF8
try {
    $env:PYTHONUTF8 = '1'
    foreach ($service in $services) {
        Write-Host "Starting $($service.Name) on port $($service.Port)..."
        $service.Process = Start-Process -FilePath $service.File -ArgumentList $service.Arguments -WorkingDirectory $service.Directory -NoNewWindow -PassThru
        $started += $service
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while ($service.Port -notin $network.GetActiveTcpListeners().Port) {
            if ($service.Process.HasExited) { throw "$($service.Name) exited with code $($service.Process.ExitCode)." }
            if ([DateTime]::UtcNow -ge $deadline) { throw "$($service.Name) did not listen on port $($service.Port) within 30 seconds." }
            Start-Sleep -Milliseconds 250
        }
    }

    $source = Invoke-RestMethod 'http://127.0.0.1:8000/api/post-source/health' -TimeoutSec 10
    $bridge = Invoke-RestMethod 'http://127.0.0.1:5173/api/health' -TimeoutSec 10
    if ($source.status -ne 'ok' -or $bridge.status -ne 'ok') { throw 'Service health checks failed.' }

    Write-Host 'Open http://127.0.0.1:5173/ . Press Ctrl+C in this window to stop the project.'
    while ($true) {
        foreach ($service in $started) {
            if ($service.Process.HasExited) { throw "$($service.Name) exited with code $($service.Process.ExitCode)." }
        }
        Start-Sleep -Seconds 1
    }
} finally {
    $env:PYTHONUTF8 = $previousPythonUtf8
    for ($index = $started.Count - 1; $index -ge 0; $index--) {
        $process = $started[$index].Process
        if (-not $process.WaitForExit(3000)) {
            $process.Kill()
            $process.WaitForExit()
        }
    }
}
