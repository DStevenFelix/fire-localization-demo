$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $projectRoot
$mapConfig = Get-Content -LiteralPath 'fire_poi/map_config.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$imageHash = (Get-FileHash -LiteralPath 'fire_poi/map_original.png' -Algorithm SHA256).Hash.ToLower()
if ($imageHash -ne $mapConfig.source.sha256) { throw 'Current map image SHA-256 mismatch' }
foreach ($oldFile in @('city_localization_data_dictionary.xlsx', 'fire_sandbox_spatial_model.json', '沙盘俯视图.png', 'frontend/assets/沙盘原始底图.jpg')) {
    if (Test-Path -LiteralPath $oldFile) { throw "Obsolete map file remains: $oldFile" }
}
if (@(git ls-files -- .env).Count -gt 0) { throw '.env is tracked' }
[pscustomobject]@{ CurrentMapVerified=$true; OldMapRemoved=$true; EnvUntracked=$true } | ConvertTo-Json -Compress
