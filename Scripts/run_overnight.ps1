# ─────────────────────────────────────────────────────────────────────────────────────────────
# run_overnight.ps1 — everything left after the water graphs, in order, unattended.
#
# Personal use only, not for distribution or resale; not for navigation.
#
#     cd F:\TrollMapPipeline
#     .\run_overnight.ps1
#
# START IT ONLY AFTER build_water_graphs.py PRINTS ITS LAST LINE. Two builds writing chartpack\
# at once is the one way to corrupt a pack, and nothing here can detect that the other one is
# still going.
#
# IT STOPS ON THE FIRST FAILURE. Every step is checked with $LASTEXITCODE and a non-zero exit
# ends the run rather than carrying a broken pack into the upload. The two steps that are
# ADVISORY say so and cannot stop it: the audit, which is a report, and check_start_here, which
# fails on purpose until --bless is run.
#
# Everything goes to outputs\overnight_<timestamp>.log via Start-Transcript, which writes plain
# text — `>` would give you UTF-16LE with a BOM.
#
# WHAT THIS LOG WILL NOT CONTAIN, AND WHY. Start-Transcript in PowerShell 5.1 does not capture
# the stdout of a NATIVE process, and every step below is `py script.py`. The 2026-08-23 run
# recorded all 93 lines of its own banners and not one line any script printed -- consolidate's
# row counts, the audit's findings, the upload's object count and verify_registry_r2's verdict
# all went to a console window that was closed by morning. Everything had to be reconstructed
# from artifacts on disk. If this script ever grows past a one-night runbook, pipe each step
# through the PowerShell pipeline (`& $Cmd 2>&1 | ForEach-Object { Write-Host $_ }`, with
# `py -u`) so the transcript keeps what it saw.
# ─────────────────────────────────────────────────────────────────────────────────────────────

$root  = 'F:\TrollMapPipeline'
$ship  = Join-Path $root 'outputs\ship_lakes.txt'
$packs = Join-Path $root 'chartpack'
$reg   = Join-Path $root 'registry'
Set-Location $root

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$log   = Join-Path $root ("outputs\overnight_$stamp.log")
Start-Transcript -Path $log | Out-Null

$t0 = Get-Date
function Step {
    param([string]$Name, [scriptblock]$Cmd, [switch]$Advisory)
    Write-Host ''
    Write-Host ('=' * 78)
    Write-Host ("STEP  $Name")
    Write-Host ("      started $(Get-Date -Format 'HH:mm:ss')  |  $([int]((Get-Date) - $script:t0).TotalMinutes) min in")
    Write-Host ('=' * 78)
    $s = Get-Date
    & $Cmd
    $code = $LASTEXITCODE
    $mins = [math]::Round(((Get-Date) - $s).TotalMinutes, 1)
    if ($code -ne 0) {
        if ($Advisory) {
            Write-Host ""
            Write-Host ("ADVISORY  $Name exited $code after $mins min - NOT stopping, this step is a report")
        } else {
            Write-Host ''
            Write-Host ('!' * 78)
            Write-Host ("STOPPED   $Name exited $code after $mins min at $(Get-Date -Format 'HH:mm:ss')")
            Write-Host ("          nothing after this ran. Read the log: $log")
            Write-Host ('!' * 78)
            Stop-Transcript | Out-Null
            exit 1
        }
    } else {
        Write-Host ''
        Write-Host ("OK        $Name  $mins min")
    }
}

Write-Host "overnight run starting $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "log: $log"

# ── the packs ────────────────────────────────────────────────────────────────────────────────
Step 'build_trolling_runs' {
    py .\scripts\build_trolling_runs.py --packs $packs --force --jobs 4 --only-lakes $ship
}

Step 'build_water_features' {
    py .\scripts\build_water_features.py --packs $packs --force --only-lakes $ship
}

# LAST of the five, and easy to forget: build_water_features rewrites `near` in place and knows
# nothing about the depth stamps.
Step 'fit_trolling_runs' {
    py .\scripts\fit_trolling_runs.py --packs $packs --jobs 4 --only-lakes $ship
}

# ── the index the app reads ───────────────────────────────────────────────────────────────────
# Expect 401 -> 373: 26 waters no feed has ever named, plus south_river and ogeechee_river_2
# under 2% charted. It rewrites ship_lakes.txt and ship_tiles.txt too.
Step 'consolidate_lake_index' {
    py .\scripts\consolidate_lake_index.py --registry $reg `
       --charted (Join-Path $reg 'charted.json') `
       --out     (Join-Path $reg 'lake_index.json')
}

# ── the audit, as a REPORT and a fresh baseline ───────────────────────────────────────────────
# The old registry\_audit.json is from 2026-08-17 and misled this project twice on 08-23, so it
# has been moved aside and this run becomes the baseline. Advisory: it exits non-zero on a
# regression and there is nothing honest to regress against yet.
Step -Name 'audit_packs (advisory, writes the new baseline)' -Advisory -Cmd {
    py .\scripts\audit_packs.py --packs $packs --registry $reg
}

# ── R2 ────────────────────────────────────────────────────────────────────────────────────────
# THE WORKER IS NOT DEPLOYED HERE. It deploys itself on push and nothing in this script pushes.
Step 'upload_garmin_to_r2' {
    py .\scripts\upload_garmin_to_r2.py --root $packs --all --jobs 6
}

Step 'verify_registry_r2' {
    py .\scripts\verify_registry_r2.py --registry $reg
}

# ── advisory tail ─────────────────────────────────────────────────────────────────────────────
# Fails on purpose while four absent_* checks have no baseline. Here so the drift is in the log
# to read over coffee, not to gate anything.
Step -Name 'check_start_here (advisory)' -Advisory -Cmd {
    py .\scripts\check_start_here.py
}

Write-Host ''
Write-Host ('=' * 78)
Write-Host ("ALL DONE  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')   total $([math]::Round(((Get-Date) - $t0).TotalMinutes,1)) min")
Write-Host ("log: $log")
Write-Host ('=' * 78)
Stop-Transcript | Out-Null
