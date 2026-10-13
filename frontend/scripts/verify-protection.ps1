$ErrorActionPreference = 'Stop'
$frontendRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Split-Path -Parent $frontendRoot
Set-Location -LiteralPath $projectRoot
$baseline = Get-Content -LiteralPath (Join-Path $frontendRoot 'docs/original-baseline.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$changed = @()
foreach ($entry in $baseline.files) {
    if (-not (Test-Path -LiteralPath $entry.Path) -or (Get-FileHash -LiteralPath $entry.Path -Algorithm SHA256).Hash -ne $entry.Hash) {
        $changed += $entry.Path
    }
}
if ($changed.Count -gt 0) { throw ('Protected original files changed: ' + ($changed -join ', ')) }
if ((Get-FileHash -LiteralPath $baseline.base_map_path -Algorithm SHA256).Hash -ne $baseline.base_map_sha256) {
    throw 'User-provided base map changed'
}
git merge-base --is-ancestor $baseline.commit HEAD
if ($LASTEXITCODE -ne 0) { throw 'Original baseline is no longer an ancestor' }
$envTracked = @(git ls-files -- .env)
if ($envTracked.Count -gt 0) { throw '.env is tracked' }
$changedNames = @(git -c core.quotepath=false diff --name-only) + @(git -c core.quotepath=false diff --cached --name-only)
$untracked = @(git -c core.quotepath=false ls-files --others --exclude-standard)
$outside = @($changedNames + $untracked | Where-Object { $_ -and $_ -notmatch '^frontend/' })
if ($outside.Count -gt 0) { throw ('Unexpected changes outside frontend: ' + ($outside -join ', ')) }
[pscustomobject]@{ ProtectedFilesVerified=$baseline.files.Count; BaseMapUnchanged=$true; EnvUntracked=$true; ChangesConfinedToFrontend=$true; UntrackedReviewFileCount=$untracked.Count } | ConvertTo-Json -Compress
git status --short
git diff --name-only
git diff --cached --name-only
