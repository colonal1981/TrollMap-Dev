# Carry local work into the fresh clone.
# EDIT THESE TWO, then run from F:\TrollMapPipeline
$old = "F:\TrollMapPipeline\TrollMap-Dev-main"
$new = "F:\TrollMapPipeline\TrollMap-Dev"

$files = @(
  "AUDIT.md"
  "Scripts/_install_rivers.ps1"
  "Scripts/build_all_chartpacks.py"
  "Scripts/build_structure.py"
  "Scripts/build_water_graphs.py"
  "Scripts/derived_bboxes.py"
  "Scripts/dump_lbl_pool.py"
  "Scripts/extract_coastal_habitat.py"
  "Scripts/fetch_osm_coastal.py"
  "Scripts/gmapmf_mar_v1.py"
  "Scripts/install_coastal_and_rivers.ps1"
  "Scripts/mar_route.py"
  "Scripts/poi_source_compare.py"
  "Scripts/r2_audit.py"
  "Scripts/rgn4_pois.py"
  "Scripts/trollmap_lake_boundaries.py"
  "Scripts/trollmap_pipeline.py"
  "Scripts/trollmap_r2_clean.py"
  "Scripts/upload_boundaries_to_r2.py"
  "Scripts/upload_garmin_to_r2.py"
  "Scripts/upload_to_r2.py"
  "Scripts/wqp_clarity_coverage.py"
  "Worker/research/facts-util.js"
  "Worker/research/limnology.js"
  "Worker/trollmap-worker.js"
  "Worker/worker-data.js"
  "Worker/worker-research.js"
  "js/data/ramps-loader.js"
  "js/lazy-data.js"
  "js/modules/coastal-layers.js"
  "js/modules/contour-data.js"
  "js/modules/gis-toggles.js"
  "js/modules/plan-builder.js"
  "js/modules/supplemental-layers.js"
  "js/modules/tide-engine.js"
  "js/modules/usgs-gauges.js"
  "js/modules/utility-sync.js"
  "package.json"
  "test/check-lake-geo.mjs"
  "test/fixtures.test.js"
  "test/usgs-gauges.test.js"
  "test/worker-auth.test.js"
  "tools/audit.mjs"
)

foreach ($f in $files) {
  $src = Join-Path $old $f
  $dst = Join-Path $new $f
  if (-not (Test-Path $src)) { Write-Host "MISSING  $f" -ForegroundColor Red; continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
  Copy-Item $src $dst -Force
  Write-Host "copied   $f"
}
Write-Host ""
Write-Host ("{0} files carried over. Now: cd $new; git status" -f $files.Count)
