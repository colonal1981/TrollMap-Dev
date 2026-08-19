# install_coastal_and_rivers.ps1 -- generated 2026-08-04
# Personal use only, not for distribution or resale; not for navigation.
#
#   cd F:\TrollMapPipeline\scripts
#   .\install_coastal_and_rivers.ps1            # dry run, writes nothing
#   .\install_coastal_and_rivers.ps1 -Go        # writes
#
# Step 1 makes the 16 coastal zone rectangles. It was 22 until 2026-08-19, when the six
# out-of-region zones were cut from coastal_catalog.py. Step 2 puts them AND the 76 river
# boundaries into the registry so build_all_chartpacks.py will actually build them --
# without a row in lakes.json and an entry in tile_lake_map.json a boundary file is
# invisible to the builder.
param([switch]$Go)

$ErrorActionPreference = 'Stop'
$REG = 'F:\TrollMapPipeline\registry'
$BND = 'F:\TrollMapPipeline\lake_boundaries'
$LBL = 'F:\TrollMapPipeline\extract\labels'
# Points at the LIVE catalog, not the downloaded repo zip. TrollMap-Dev-main is a
# snapshot that goes stale the moment scripts\coastal_catalog.py is edited, and on
# 2026-08-04 the two had diverged in both directions. Generate from the file you edit.
$CAT = 'F:\TrollMapPipeline\scripts\coastal_catalog.py'
# NOT `$goFlag = if ($Go) { @('--go') }` -- PowerShell collapses a one-element array to a
# scalar there, and `@goFlag` on a string splats it one CHARACTER at a time. That is where
# `unrecognized arguments: - - g o` came from. Build the array, then add to it.
$goFlag = @()
if ($Go) { $goFlag += '--go' }
Write-Host $(if ($Go) { 'WRITING (-Go)' } else { 'DRY RUN -- add -Go to write' }) -ForegroundColor $(if ($Go) { 'Green' } else { 'Yellow' })

Write-Host "`n=== 1/2  coastal zone boundaries ===" -ForegroundColor Cyan
py .\make_coastal_boundaries.py --catalog $CAT --out $BND @goFlag
if ($LASTEXITCODE -ne 0) { throw "make_coastal_boundaries failed" }

$coastal = @(
  'coast_ace_basin_sc=SC',
  'coast_beaufort_sc=SC',
  'coast_brunswick_nc=NC',
  'coast_brunswick_st_simons_ga=GA',
  'coast_cape_fear_nc=NC',
  'coast_cape_romain_sc=SC',
  'coast_charleston_sc=SC',
  'coast_hilton_head_sc=SC',
  'coast_murrells_inlet_sc=SC',
  'coast_ossabaw_st_catherines_ga=GA',
  'coast_santee_delta_sc=SC',
  'coast_sapelo_altamaha_ga=GA',
  'coast_savannah_ga=GA',
  'coast_st_helena_sc=SC',
  'coast_topsail_new_river_nc=NC',
  'coast_winyah_bay_sc=SC'
)

$rivers = @(
  'alabaha_river=GA',
  'alapaha_river=GA',
  'altamaha_river=GA',
  'big_swamp=NC',
  'black_mingo_creek=SC',
  'black_river_2=NC',
  'black_river=SC',
  'broad_river_2=SC',
  'broad_river_3=GA',
  'broad_river=NC',
  'canoochee_river=GA',
  'cape_fear_river=NC',
  'catawba_river_2=NC',
  'chattahoochee_river_2=GA',
  'chattahoochee_river_3=GA',
  'chattahoochee_river_4=GA',
  'chattahoochee_river_5=GA',
  'chattahoochee_river=GA',
  'chessie_creek=SC',
  'combahee_river=SC',
  'contentnea_creek=NC',
  'coosa_river=GA',
  'coosawattee_river=GA',
  'dan_river=NC',
  'deep_river=NC',
  'edisto_river=SC',
  'etowah_river=GA',
  'first_broad_river=NC',
  'flint_river_2=GA',
  'flint_river_3=GA',
  'flint_river=GA',
  'french_broad_river=NC',
  'great_pee_dee_river=SC',
  'johns_river=NC',
  'kinchafoonee_creek=GA',
  'little_pee_dee_river=SC',
  'little_river=GA',
  'little_satilla_river=GA',
  'little_tennessee_river=NC',
  'lumber_river=NC',
  'lynches_river=SC',
  'meherrin_river=NC',
  'neuse_river=NC',
  'north_fork_edisto_river=SC',
  'northeast_cape_fear_river=NC',
  'ochlocknee_river=GA',
  'ocmulgee_river=GA',
  'oconee_river_2=GA',
  'oconee_river=GA',
  'ogeechee_river_2=GA',
  'ogeechee_river=GA',
  'ohoopee_river=GA',
  'oostanaula_river=GA',
  'pee_dee_river_2=NC',
  'roanoke_river=NC',
  'saluda_river_2=SC',
  'saluda_river_lower_saluda=SC',
  'saluda_river=SC',
  'santee_river=SC',
  'satilla_river=GA',
  'savannah_river=GA',
  'south_fork_edisto_river=SC',
  'south_fork_new_river=NC',
  'south_river=NC',
  'south_yadkin_river=NC',
  'spring_creek=GA',
  'st_marys_river=GA',
  'suwannee_river_2=GA',
  'suwannee_river=GA',
  'tail_race_canal=SC',
  'toccoa_river=GA',
  'tuckasegee_river=NC',
  'uwharrie_river=NC',
  'white_oak_creek=GA',
  'withlacoochee_river=GA',
  'yadkin_river=NC'
)

$lakeArgs = @()
foreach ($x in ($coastal + $rivers)) { $lakeArgs += '--lake'; $lakeArgs += $x }

Write-Host "`n=== 2/2  install $($coastal.Count) zones + $($rivers.Count) rivers into the registry ===" -ForegroundColor Cyan
py .\install_registry_boundary.py --registry $REG --boundaries $BND --labels $LBL @lakeArgs @goFlag
if ($LASTEXITCODE -ne 0) { throw "install_registry_boundary failed" }

if (-not $Go) {
  Write-Host "`nDRY RUN -- nothing written. Re-run with -Go once the above reads right." -ForegroundColor Yellow
}
