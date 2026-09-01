# collapse_duplicate_profiles.ps1 -- remove the four thin duplicate research profiles.
#
# Personal use only, not for distribution or resale; not for navigation.
#
# WHY THESE FOUR. Counted 2026-09-01 across all 80 objects in the bucket against all 358 registry
# rows: four waters carry two profiles each. In every case the older one is the better one and was
# written in July; the newer one was written this week, into a hole a display-name change had
# already made, because the id lookup only ever asked with one spelling.
#
#   Richard B Russell Lake   KEEP lake_russell_sc    29 sources, thermocline 22 ft, anoxic 22 ft
#                            DROP lake_richard_russell_ga          6 facts
#   Lake Sidney Lanier       KEEP lake_lanier_ga     thermocline 22.5 ft, anoxic 30 ft, Secchi 8.6
#                            DROP lake_sidney_lanier_hall_co_ga    all three null
#   Nottely Lake             KEEP lake_nottely_ga    thermocline 46 ft, anoxic 60 ft, Secchi 8.4
#                            DROP nottely_lake_ga
#   Watauga Lake             KEEP watauga_tn         thermocline 28 ft, Secchi 6.8 ft
#                            DROP watauga_lake_tn
#
# EACH DELETE NAMES ITS ID EXPLICITLY. Deleting by lake name resolves through the candidate list,
# which is safe once and wrong twice: the first run takes the thin duplicate and a second run takes
# the good profile that was left behind. An id is the same object every time it is asked for, and
# the Worker 404s rather than reporting a clean run if it is already gone.
#
# RUN THIS AFTER THE WORKER HAS DEPLOYED the commit that adds `id` to /research/delete. Before
# that, the parameter is ignored and the delete would resolve by name.

$ErrorActionPreference = 'Stop'
if (-not $env:TROLLMAP_SYNC_TOKEN) {
  Write-Host '!! TROLLMAP_SYNC_TOKEN is not set in this shell. The Worker will refuse.' -ForegroundColor Red
  exit 1
}
$worker = 'https://trollmap-worker.colonal1981.workers.dev'
$headers = @{ 'X-Sync-Token' = $env:TROLLMAP_SYNC_TOKEN; 'Content-Type' = 'application/json' }

$drop = @(
  @{ lake = 'Lake Richard Russell, GA';            id = 'lake_richard_russell_ga' },
  @{ lake = 'Lake Sidney Lanier (Hall Co, GA)';    id = 'lake_sidney_lanier_hall_co_ga' },
  @{ lake = 'Nottely Lake, GA';                    id = 'nottely_lake_ga' },
  @{ lake = 'Watauga Lake, TN';                    id = 'watauga_lake_tn' }
)

foreach ($d in $drop) {
  $body = @{ lakeName = $d.lake; id = $d.id } | ConvertTo-Json -Compress
  Write-Host ("removing {0}  ({1})" -f $d.id, $d.lake)
  try {
    $r = Invoke-RestMethod -Uri "$worker/research/delete" -Method Post -Headers $headers -Body $body
    Write-Host ("   ok -- {0} object(s) removed" -f $r.deleted) -ForegroundColor Green
  } catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    Write-Host ("   FAILED -- {0}" -f $msg) -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host 'Now confirm each water reads its July profile:' -ForegroundColor Cyan
foreach ($d in $drop) {
  $u = "$worker/research/get?lake=" + [uri]::EscapeDataString($d.lake)
  try {
    $p = Invoke-RestMethod -Uri $u
    $lim = $p.profile.limnology
    Write-Host ("   {0,-34} -> {1}  thermocline {2}  anoxic {3}  secchi {4}" -f `
      $d.lake, $p.sanitized, $lim.thermocline.summerDepthFt, $lim.oxygen.anoxicBelowFt, $lim.waterClarity.secchiFt)
  } catch {
    Write-Host ("   {0,-34} -> NO PROFILE FOUND" -f $d.lake) -ForegroundColor Red
  }
}
