#!/usr/bin/env python3
"""
TrollMap Build Contours — unified i-Boating → contour chartpack pipeline.

This is ONE script. It replaces the manual two-step (capture + extract) workflow
with a single command that produces a chartpack folder TrollMap can import directly.

What it does, in order:
  1. Reads a job (job.json OR inline CLI args)
  2. Captures i-Boating web tiles covering the job bbox/polygon (with retries)
  3. Extracts transparent contour/depth-number overlays from each capture
  4. Packages everything into a chartpack/ folder:
        chartpack/
          chartpack.json           # TrollMap-friendly metadata
          capture_manifest.json    # full capture record (tile grid, scores)
          contours/                # PNG + .georef.json pairs (drop into TrollMap)
          raws/                    # original i-Boating tiles (kept for re-extract)
          labels.geojson           # placeholder; future OCR labels go here

Subcommands:
  build      full pipeline (default): capture → extract → package
  capture    only capture tiles (skip contour extraction)
  extract    only extract contours from existing raw tiles in a job folder
  package    re-package an already-captured job folder into a chartpack

Install once:
  py -m pip install playwright pillow numpy opencv-python
  py -m playwright install chromium

Examples:
  # Full pipeline from inline args
  py trollmap_build_contours.py build ^
      --url "https://fishing-app.gpsnauticalcharts.com/i-boating-fishing-web-app/fishing-marine-charts-navigation.html#16.2/34.3796/-80.7329" ^
      --north 34.386 --south 34.372 --west -80.748 --east -80.724 ^
      --out chartpacks/wateree_south

  # Full pipeline from a job.json
  py trollmap_build_contours.py build --job job.json

  # Extract-only (already have raw tiles)
  py trollmap_build_contours.py extract ./chartpacks/wateree_south_work

  # Re-package a work folder
  py trollmap_build_contours.py package ./chartpacks/wateree_south_work

Polygon input (future-proofing):
  --polygon lon,lat lon,lat ...  (closed ring, repeats first/last OK)
  For now, polygons are expanded to a tight bounding box for capture.
  Future versions will rasterize the polygon to skip far-west coves that
  force capturing huge land rectangles.

Design notes:
  - Capture logic is the same proven i-Boating CLEAN v5 logic
    (URL hash moves, contour-detail retry, land/water gating).
  - Contour extraction is the proven v5 logic (pink exclusion,
    shallow-blue numbers, EDGE_CLIP, dark-stroke fix).
  - The chartpack/contours/ folder is drop-in: PNG + .georef.json pairs
    in the exact shape TrollMap's bulk importer already accepts
    (root keys: north/south/east/west).
  - Leaves a labels.geojson file in place for the planned
    vector-label OCR step so the chartpack format doesn't have to change later.
"""
import argparse
import json
import math
import os
import re
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import urldefrag

import numpy as np
from PIL import Image, ImageFilter

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

TILE_SIZE = 512  # Mapbox GL world pixel tile size
APP_VERSION = "trollmap_build_contours_v1"

# Contour extraction thresholds (mirrors v5 best extractor).
DETAIL_MIN = 5
DARK_DETAIL_MIN = 2
DARK_MAX = 180
EDGE_CLIP = 25
BLUE_MAX_AREA = 150
BLUE_MAX_W = 40
BLUE_MAX_H = 40

# Two-layer split: numbers vs contour lines (digit shape heuristics).
# Numbers in i-Boating tiles are often gray-tinted (RGB ~(82,90,92)) not pure
# black, and they pass the thin-detail test, so we classify by shape, not by
# which mask they came from.
NUM_MIN_AREA = 15       # ignore tiny noise
NUM_MAX_AREA = 200      # ignore huge blobs / shoreline fragments
NUM_MIN_ASPECT = 0.30   # ignore extremely wide shapes
NUM_MAX_ASPECT = 1.8    # ignore long thin line fragments
NUM_MIN_HEIGHT = 4      # must be at least a few pixels tall
NUM_MAX_HEIGHT = 25     # digits at i-Boating zoom 16.2 are 8-15px tall

# Blue shallow-water depth numbers are drawn in NAVY BLUE:
#   RGB ~(35, 47, 222) or (4, 6, 254) — very low R, low G, very high B
# Distinct from:
#   - Water fill: RGB (115, 182, 239) — R is ~115, much higher than numbers
#   - Contour lines: RGB (107, 120, 133) — gray, not saturated blue
#   - Deep-water gray numbers: RGB (82, 90, 92) — chroma ~10
# So the rule is: r AND g small, b large, b - r AND b - g very large.
BLUE_NUM_R_MAX = 100
BLUE_NUM_G_MAX = 100
BLUE_NUM_B_MIN = 150
BLUE_NUM_BR_MIN = 100   # b - r must be very large
BLUE_NUM_BG_MIN = 100   # b - g must be very large
BLUE_NUM_DETAIL_MIN = 4 # local contrast (text edges; numbers are smaller than contour lines)

# Optional playwright import — only required for capture subcommand.
try:
    from playwright.sync_api import (
        sync_playwright,
        TimeoutError as PlaywrightTimeoutError,
        Error as PlaywrightError,
    )
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False


# ─────────────────────────────────────────────────────────────────────────────
# URL + projection helpers
# ─────────────────────────────────────────────────────────────────────────────

def clean_url(url):
    """Strip common terminal/chat paste junk around i-Boating URLs."""
    url = str(url).strip().strip('"').strip("'")
    if url.lower().startswith("url:"):
        url = url.split(":", 1)[1].strip()
    m = re.search(r"\((https?://[^)]+)\)", url)
    if m:
        url = m.group(1)
    url = url.strip("[]")
    return url


def parse_hash_url(url):
    """Parse i-Boating URL like ...html#16.2/34.3796/-80.7329."""
    url = clean_url(url)
    base, frag = urldefrag(url)
    m = re.match(r"([0-9.]+)/(-?[0-9.]+)/(-?[0-9.]+)", frag or "")
    if not m:
        raise ValueError(
            "URL must end with hash like #16.2/34.3796/-80.7329\n"
            f"Got fragment: {frag!r}"
        )
    return base, float(m.group(1)), float(m.group(2)), float(m.group(3))


def lonlat_to_world_px(lon, lat, zoom):
    lat = max(min(lat, 85.05112878), -85.05112878)
    scale = TILE_SIZE * (2 ** zoom)
    x = (lon + 180.0) / 360.0 * scale
    siny = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * scale
    return x, y


def world_px_to_lonlat(x, y, zoom):
    scale = TILE_SIZE * (2 ** zoom)
    lon = x / scale * 360.0 - 180.0
    n = math.pi - 2.0 * math.pi * y / scale
    lat = math.degrees(math.atan(math.sinh(n)))
    return lon, lat


def make_url(base, zoom, lat, lon):
    return f"{base}#{zoom:.2f}/{lat:.7f}/{lon:.7f}"


def bounds_for_crop(center_lon, center_lat, zoom, viewport_w, viewport_h, crop):
    cx, cy = lonlat_to_world_px(center_lon, center_lat, zoom)
    left, top, right, bottom = crop
    crop_left = left
    crop_top = top
    crop_right = viewport_w - right
    crop_bottom = viewport_h - bottom
    west_x = cx + (crop_left - viewport_w / 2)
    east_x = cx + (crop_right - viewport_w / 2)
    north_y = cy + (crop_top - viewport_h / 2)
    south_y = cy + (crop_bottom - viewport_h / 2)
    west, north = world_px_to_lonlat(west_x, north_y, zoom)
    east, south = world_px_to_lonlat(east_x, south_y, zoom)
    return {"north": north, "south": south, "west": west, "east": east}


def center_offset(center_lon, center_lat, zoom, dx_px, dy_px):
    cx, cy = lonlat_to_world_px(center_lon, center_lat, zoom)
    lon, lat = world_px_to_lonlat(cx + dx_px, cy + dy_px, zoom)
    return lat, lon


# ─────────────────────────────────────────────────────────────────────────────
# Polygon handling (future-proofing)
# ─────────────────────────────────────────────────────────────────────────────

def polygon_bbox(polygon):
    """Return [south, west, north, east] for a [[lon,lat], ...] ring."""
    if not polygon or len(polygon) < 3:
        raise ValueError("Polygon needs at least 3 [lon,lat] points.")
    lons = [p[0] for p in polygon]
    lats = [p[1] for p in polygon]
    return min(lats), min(lons), max(lats), max(lons)


def parse_polygon_arg(arg):
    """Parse --polygon as 'lon,lat lon,lat ...' or repeated --polygon flags."""
    parts = re.split(r"[\s;]+", arg.strip())
    pts = []
    for p in parts:
        if not p:
            continue
        a, b = p.split(",")
        pts.append([float(a), float(b)])
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])  # close ring
    return pts


# ─────────────────────────────────────────────────────────────────────────────
# Job loading
# ─────────────────────────────────────────────────────────────────────────────

def load_job(args):
    """Return a normalized job dict from job.json + CLI overrides."""
    job = {}
    if args.job:
        job_path = Path(args.job)
        if not job_path.exists():
            raise SystemExit(f"--job file not found: {job_path}")
        job = json.loads(job_path.read_text(encoding="utf-8"))

    # CLI overrides win.
    if args.url:
        job["source_url"] = args.url
    if args.name:
        job["name"] = args.name
    if args.zoom is not None:
        job["zoom_override"] = args.zoom
    if args.polygon:
        job["polygon"] = parse_polygon_arg(args.polygon)
    if any(v is not None for v in (args.north, args.south, args.west, args.east)):
        job["bbox"] = {
            "north": args.north if args.north is not None else job.get("bbox", {}).get("north"),
            "south": args.south if args.south is not None else job.get("bbox", {}).get("south"),
            "west": args.west if args.west is not None else job.get("bbox", {}).get("west"),
            "east": args.east if args.east is not None else job.get("bbox", {}).get("east"),
        }

    if not job.get("source_url"):
        raise SystemExit("source_url is required (use --url or 'source_url' in job.json).")

    base, zoom, seed_lat, seed_lon = parse_hash_url(job["source_url"])
    if "zoom_override" in job and job["zoom_override"]:
        zoom = float(job["zoom_override"])

    # Resolve bbox: prefer explicit bbox; otherwise derive from polygon.
    bbox = job.get("bbox")
    polygon = job.get("polygon")
    if not bbox and polygon:
        s, w, n, e = polygon_bbox(polygon)
        bbox = {"north": n, "south": s, "west": w, "east": e}
        job["bbox_derived_from_polygon"] = True
    if not bbox:
        raise SystemExit("Need either 'bbox' or 'polygon' in the job.")

    required = ("north", "south", "west", "east")
    missing = [k for k in required if bbox.get(k) is None]
    if missing:
        raise SystemExit(f"bbox missing keys: {missing}")

    # Defaults.
    job.setdefault("name", "trollmap_chart")
    job.setdefault("viewport", [2400, 1400])
    job.setdefault("overlap", 0.25)
    job.setdefault("wait", 12.0)
    job.setdefault("retries", 4)
    job.setdefault("water", 0.04)
    job.setdefault("contour_score", 0.0012)
    job.setdefault("no_contour_check", False)
    job.setdefault("crop", [55, 0, 55, 35])
    job.setdefault("headed", False)
    job.setdefault("extract_contours", True)

    job["_resolved"] = {
        "base_url": base,
        "zoom": zoom,
        "seed_lat": seed_lat,
        "seed_lon": seed_lon,
        "bbox": bbox,
        "polygon": polygon,
    }
    return job


# ─────────────────────────────────────────────────────────────────────────────
# Capture (delegates the proven v5 logic)
# ─────────────────────────────────────────────────────────────────────────────

def capture(job, work_dir):
    if not HAS_PLAYWRIGHT:
        raise SystemExit(
            "Playwright is not installed.\n"
            "Run: py -m pip install playwright && py -m playwright install chromium"
        )

    res = job["_resolved"]
    W, H = job["viewport"]
    crop = tuple(job["crop"])
    overlap = job["overlap"]
    wait = job["wait"]
    retries = job["retries"]
    water_t = job["water"]
    score_t = job["contour_score"]
    bbox = res["bbox"]
    zoom = res["zoom"]
    base = res["base_url"]

    step_x = (W - crop[0] - crop[2]) * (1 - overlap)
    step_y = (H - crop[1] - crop[3]) * (1 - overlap)
    nw_x, nw_y = lonlat_to_world_px(bbox["west"], bbox["north"], zoom)
    se_x, se_y = lonlat_to_world_px(bbox["east"], bbox["south"], zoom)
    n_cols = max(1, math.ceil((se_x - nw_x) / step_x))
    n_rows = max(1, math.ceil((se_y - nw_y) / step_y))
    start_lon, start_lat = world_px_to_lonlat(nw_x + W / 2, nw_y + H / 2, zoom)

    print(f"\n[CAPTURE] {job['name']}")
    print(f"  zoom={zoom}  bbox=N{bbox['north']} S{bbox['south']} W{bbox['west']} E{bbox['east']}")
    print(f"  grid={n_rows}x{n_cols} = {n_rows*n_cols} max tiles")
    print(f"  viewport={W}x{H}  step={step_x:.0f},{step_y:.0f}px  overlap={overlap}")
    print(f"  wait={wait}s  retries={retries}  contour_check={'OFF' if job['no_contour_check'] else f'ON @ {score_t}'}")
    print(f"  work={work_dir}\n")

    manifest = {
        "app": APP_VERSION,
        "phase": "capture",
        "name": job["name"],
        "source_url": job["source_url"],
        "base_url": base,
        "bbox": bbox,
        "polygon": res["polygon"],
        "zoom": zoom,
        "viewport": [W, H],
        "crop": list(crop),
        "overlap": overlap,
        "step_px": [step_x, step_y],
        "water_threshold": water_t,
        "contour_score_threshold": score_t,
        "captures": [],
        "skipped_land": 0,
        "failed_no_contours": 0,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    saved = skipped = failed = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not job["headed"])
        page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        _load_iboating_once(page, job["source_url"])
        _wait_for_map(page, wait)

        for r in range(n_rows):
            for c in range(n_cols):
                lat, lon = center_offset(start_lon, start_lat, zoom, c * step_x, r * step_y)
                url = make_url(base, zoom, lat, lon)
                raw_path = work_dir / f"iboating_R{r:03d}_C{c:03d}_raw.png"
                img_path = work_dir / f"iboating_R{r:03d}_C{c:03d}.png"

                ok_img = None
                last_wf = 0.0
                last_cs = 0.0
                for attempt in range(retries + 1):
                    _move_map_hash(page, zoom, lat, lon, base)
                    _wait_for_map(page, wait + attempt * 3)
                    cropped, wf, cs = _screenshot_and_score(page, raw_path, crop, W, H)
                    last_wf, last_cs = wf, cs

                    if wf < water_t:
                        break

                    if job["no_contour_check"] or cs >= score_t:
                        ok_img = cropped
                        break

                    print(f"  R{r:03d} C{c:03d}: contour detail missing, retry {attempt+1}/{retries+1}  water={wf:.3f} score={cs:.5f}")

                if ok_img is None:
                    if last_wf < water_t:
                        raw_path.unlink(missing_ok=True)
                        skipped += 1
                        print(f"  R{r:03d} C{c:03d}: skip land  water={last_wf:.3f} score={last_cs:.5f}")
                    else:
                        failed += 1
                        fail_path = work_dir / f"iboating_R{r:03d}_C{c:03d}_FAILED_NO_CONTOURS.png"
                        raw_path.replace(fail_path)
                        print(f"  R{r:03d} C{c:03d}: FAILED no contours  water={last_wf:.3f} score={last_cs:.5f}")
                    continue

                ok_img.save(img_path)
                raw_path.unlink(missing_ok=True)

                b = bounds_for_crop(lon, lat, zoom, W, H, crop)
                sidecar = {
                    "file": img_path.name,
                    "row": r,
                    "col": c,
                    "centerLat": round(lat, 8),
                    "centerLon": round(lon, 8),
                    "zoom": zoom,
                    "waterFraction": round(last_wf, 5),
                    "contourScore": round(last_cs, 6),
                    "north": round(b["north"], 8),
                    "south": round(b["south"], 8),
                    "west": round(b["west"], 8),
                    "east": round(b["east"], 8),
                }
                (work_dir / f"iboating_R{r:03d}_C{c:03d}.georef.json").write_text(
                    json.dumps(sidecar, indent=2), encoding="utf-8"
                )
                manifest["captures"].append(sidecar)
                saved += 1
                print(f"  R{r:03d} C{c:03d}: saved  water={last_wf:.3f} score={last_cs:.5f}")

            manifest["skipped_land"] = skipped
            manifest["failed_no_contours"] = failed
            (work_dir / "capture_manifest.json").write_text(
                json.dumps(manifest, indent=2), encoding="utf-8"
            )

        browser.close()

    print(f"\n[CAPTURE] done — saved {saved}, land {skipped}, failed {failed}")
    return manifest


# Playwright helpers (kept private to this module)
def _safe_goto(page, url, tries=3):
    last_err = None
    for _ in range(tries):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            return True
        except PlaywrightError as e:
            last_err = e
            page.wait_for_timeout(2500)
            if page.url and page.url != "about:blank":
                return True
    print(f"    navigation warning: {last_err}")
    return False


def _load_iboating_once(page, url):
    if not _safe_goto(page, url, tries=4) or page.url == "about:blank":
        raise RuntimeError("Could not load i-Boating page; browser stayed on about:blank")


def _move_map_hash(page, zoom, lat, lon, base):
    h = f"{zoom:.2f}/{lat:.7f}/{lon:.7f}"
    try:
        page.evaluate(
            """(h) => {
                if (location.hash.slice(1) !== h) {
                  location.hash = h;
                  window.dispatchEvent(new HashChangeEvent('hashchange'));
                }
            }""",
            h,
        )
    except PlaywrightError:
        _safe_goto(page, base + "#" + h, tries=2)


def _wait_for_map(page, seconds):
    try:
        page.wait_for_load_state("networkidle", timeout=int(max(5, seconds) * 1000))
    except PlaywrightTimeoutError:
        pass
    page.wait_for_timeout(int(seconds * 1000))


def _crop_image(path, crop, W, H):
    img = Image.open(path).convert("RGB")
    left, top, right, bottom = crop
    return img.crop((left, top, W - right, H - bottom))


def _local_detail(gray_u8, radius=2):
    blur = np.array(Image.fromarray(gray_u8, "L").filter(ImageFilter.GaussianBlur(radius=radius))).astype(np.int16)
    return np.abs(gray_u8.astype(np.int16) - blur)


def _water_fraction(img):
    rgb = np.array(img.convert("RGB"))
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    white = (r > 230) & (g > 230) & (b > 230)
    water = ((b > r + 10) | (b > 145)) & ~white
    return float(np.sum(water)) / max(1, water.size)


def _contour_score(img):
    rgb = np.array(img.convert("RGB"))
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    mx = np.maximum.reduce([r, g, b])
    mn = np.minimum.reduce([r, g, b])
    gray = ((r * 30 + g * 59 + b * 11) / 100).astype(np.uint8)
    detail = _local_detail(gray, 2)
    white = (r > 228) & (g > 228) & (b > 228)
    black = mx < 18
    land = (r > 135) & (g > 115) & (b < 150) & (np.abs(r - g) < 85)
    pink = (r > 140) & (b > 140) & (g < 135) & (np.abs(r - b) < 60) & (r > g + 40)
    thin = (~white) & (~black) & (~pink) & (~land) & (detail >= 4) & (mx < 220) & (mn > 12)
    dark = (~white) & (~black) & (~pink) & (detail >= 2) & (mx < 150) & (mn > 10)
    return float(np.sum(thin | dark)) / max(1, thin.size)


def _screenshot_and_score(page, raw_path, crop, W, H):
    page.screenshot(path=str(raw_path), full_page=False)
    cropped = _crop_image(raw_path, crop, W, H)
    return cropped, _water_fraction(cropped), _contour_score(cropped)


# ─────────────────────────────────────────────────────────────────────────────
# Contour extraction (v5 best extractor)
# ─────────────────────────────────────────────────────────────────────────────

def _local_detail_np(channel_u8, radius=2):
    img = Image.fromarray(channel_u8.astype(np.uint8), "L")
    blur = np.array(img.filter(ImageFilter.GaussianBlur(radius=radius))).astype(np.int16)
    return np.abs(channel_u8.astype(np.int16) - blur)


def _small_components(mask, max_area, max_w, max_h):
    try:
        import cv2
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
        keep = np.zeros_like(mask, dtype=bool)
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if area <= max_area and w <= max_w and h <= max_h:
                keep[labels == i] = True
        return keep
    except Exception:
        return np.zeros_like(mask, dtype=bool)


def make_overlay(img):
    """Return RGBA combining ALL depth-chart content in one layer:
    - gray contour lines
    - black/dark depth numbers (deep water)
    - navy blue shallow-water depth numbers (RGB ~35,47,222)

    Used as the default single-PNG-per-tile output. TrollMap imports each
    PNG + .georef.json pair as one chart layer; this gives you lines AND
    numbers in the same layer.

    For a split into two layers (lines vs numbers), use make_overlays().
    """
    rgb = np.array(img.convert("RGB"))
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    mx = np.maximum.reduce([r, g, b])
    mn = np.minimum.reduce([r, g, b])
    gray = ((r * 30 + g * 59 + b * 11) / 100).astype(np.uint8)
    detail_gray = _local_detail_np(gray, 2)

    white_ui = (mx > 228)
    black_ui = (mx < 18)
    pink = (r > 140) & (b > 140) & (g < 135) & (np.abs(r - b) < 50) & (r > g + 50)
    water_blue = (b > 160) & (b > r + 50) & (b > g + 30) & (mx > 150) & (detail_gray < 6)
    teal_artifact = (b > 180) & (g > 180) & (b > r + 20) & (g > r + 20) & (mx > 180) & (detail_gray < 8)

    # Layer A — proven v5 contour mask: gray lines + black/dark depth numbers.
    gray_contour = (~white_ui) & (~black_ui) & (~pink) & \
                   (detail_gray >= DETAIL_MIN) & (mx < 205) & (mn > 15)
    dark_stroke = (~white_ui) & (~black_ui) & (~pink) & \
                  (mx < DARK_MAX) & (detail_gray >= DARK_DETAIL_MIN)
    contour_mask = (gray_contour | dark_stroke) & ~water_blue & ~teal_artifact & ~pink

    # Layer B — navy blue shallow-water depth numbers (the missing layer).
    # i-Boating palette (zoom 16.2, sampled from real tiles):
    #   water fill (bright blue): RGB ~(115, 182, 239), chroma ~124
    #   shallow depth numbers:    RGB ~(35, 47, 222) — NAVY BLUE
    #   contour lines (gray):     RGB ~(107, 120, 133), chroma ~25
    #   deep-water gray numbers:  RGB ~(82, 90, 92), chroma ~10
    # Key signature: low R + low G + very high B (navy blue).
    # NOTE: do NOT use the white_ui filter here — navy blue numbers have
    # mx ~ 220-235 and would be classified as "white UI" otherwise.
    blue_num_color = (
        (r <= BLUE_NUM_R_MAX)
        & (g <= BLUE_NUM_G_MAX)
        & (b >= BLUE_NUM_B_MIN)
        & ((b - r) >= BLUE_NUM_BR_MIN)
        & ((b - g) >= BLUE_NUM_BG_MIN)
    )
    blue_num_detail = (detail_gray >= BLUE_NUM_DETAIL_MIN)
    blue_num_mask = (~black_ui) & (~pink) & blue_num_color & blue_num_detail

    # Filter blue-numbers by digit shape (compact blob).
    numbers_mask = np.zeros_like(blue_num_mask, dtype=bool)
    try:
        import cv2
        n, labels, stats, _ = cv2.connectedComponentsWithStats(
            blue_num_mask.astype(np.uint8), 8
        )
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if area < 1:
                continue
            aspect = w / max(1, h)
            looks_like_digit = (
                NUM_MIN_AREA <= area <= NUM_MAX_AREA
                and NUM_MIN_ASPECT <= aspect <= NUM_MAX_ASPECT
                and NUM_MIN_HEIGHT <= h <= NUM_MAX_HEIGHT
            )
            if looks_like_digit:
                numbers_mask[labels == i] = True
    except Exception:
        numbers_mask = blue_num_mask

    # Combine: contour lines + black numbers + navy blue numbers.
    combined_mask = contour_mask | numbers_mask

    # Edge clip.
    e = EDGE_CLIP
    h, w = combined_mask.shape
    if e:
        combined_mask[:e, :] = False
        combined_mask[-e:, :] = False
        combined_mask[:, :e] = False
        combined_mask[:, -e:] = False

    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[:, :, 3] = np.where(combined_mask, 220, 0).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def make_overlays(img):
    """Return (contours_rgba, numbers_rgba) — the two-layer split.
    contours_rgba: gray contour lines + black/dark depth numbers (v5).
    numbers_rgba: navy blue shallow-water depth numbers (new).
    Use make_overlay() for the single-layer combined version.
    """
    rgb = np.array(img.convert("RGB"))
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    mx = np.maximum.reduce([r, g, b])
    mn = np.minimum.reduce([r, g, b])
    gray = ((r * 30 + g * 59 + b * 11) / 100).astype(np.uint8)
    detail_gray = _local_detail_np(gray, 2)

    white_ui = (mx > 228)
    black_ui = (mx < 18)
    pink = (r > 140) & (b > 140) & (g < 135) & (np.abs(r - b) < 50) & (r > g + 50)
    water_blue = (b > 160) & (b > r + 50) & (b > g + 30) & (mx > 150) & (detail_gray < 6)
    teal_artifact = (b > 180) & (g > 180) & (b > r + 20) & (g > r + 20) & (mx > 180) & (detail_gray < 8)

    gray_contour = (~white_ui) & (~black_ui) & (~pink) & \
                   (detail_gray >= DETAIL_MIN) & (mx < 205) & (mn > 15)
    dark_stroke = (~white_ui) & (~black_ui) & (~pink) & \
                  (mx < DARK_MAX) & (detail_gray >= DARK_DETAIL_MIN)
    contour_mask = (gray_contour | dark_stroke) & ~water_blue & ~teal_artifact & ~pink

    blue_num_color = (
        (r <= BLUE_NUM_R_MAX)
        & (g <= BLUE_NUM_G_MAX)
        & (b >= BLUE_NUM_B_MIN)
        & ((b - r) >= BLUE_NUM_BR_MIN)
        & ((b - g) >= BLUE_NUM_BG_MIN)
    )
    blue_num_detail = (detail_gray >= BLUE_NUM_DETAIL_MIN)
    blue_num_mask = (~black_ui) & (~pink) & blue_num_color & blue_num_detail

    numbers_mask = np.zeros_like(blue_num_mask, dtype=bool)
    try:
        import cv2
        n, labels, stats, _ = cv2.connectedComponentsWithStats(
            blue_num_mask.astype(np.uint8), 8
        )
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if area < 1:
                continue
            aspect = w / max(1, h)
            if (NUM_MIN_AREA <= area <= NUM_MAX_AREA
                and NUM_MIN_ASPECT <= aspect <= NUM_MAX_ASPECT
                and NUM_MIN_HEIGHT <= h <= NUM_MAX_HEIGHT):
                numbers_mask[labels == i] = True
    except Exception:
        numbers_mask = blue_num_mask

    e = EDGE_CLIP
    h, w = contour_mask.shape
    if e:
        contour_mask[:e, :] = False
        contour_mask[-e:, :] = False
        contour_mask[:, :e] = False
        contour_mask[:, -e:] = False
        numbers_mask[:e, :] = False
        numbers_mask[-e:, :] = False
        numbers_mask[:, :e] = False
        numbers_mask[:, -e:] = False

    def _to_rgba(mask):
        out = np.zeros((h, w, 4), dtype=np.uint8)
        out[:, :, 3] = np.where(mask, 220, 0).astype(np.uint8)
        return Image.fromarray(out, "RGBA")

    return _to_rgba(contour_mask), _to_rgba(numbers_mask)


def extract_contours(work_dir, out_dir=None, two_layer=False):
    """Walk work_dir, build overlay PNGs.

    Default (single layer): one PNG per tile with everything combined
    (gray contour lines + black/dark depth numbers + navy blue shallow
    depth numbers). Drop the resulting folder straight into TrollMap.

    If two_layer=True: writes two folders, contours/ and numbers/, with
    the line+dark-numbers and navy-blue-numbers masks separated.

    If a single out_dir is passed (legacy), it goes to contours only.
    Default layout: <work_dir>/contours (single) or
                    <work_dir>/contours + <work_dir>/numbers (two-layer).
    """
    files = sorted([
        p for p in work_dir.glob("iboating_R*_C*.png")
        if "_contours" not in p.stem and "_numbers" not in p.stem and "_raw" not in p.stem
    ])
    if not files:
        print(f"[EXTRACT] no iboating_R*_C*.png in {work_dir}")
        return {"contours": [], "numbers": []}

    contours_dir = Path(out_dir) if out_dir else work_dir / "contours"
    contours_dir.mkdir(parents=True, exist_ok=True)
    numbers_dir = None
    if two_layer:
        numbers_dir = work_dir / "numbers"
        numbers_dir.mkdir(parents=True, exist_ok=True)

    if two_layer:
        print(f"[EXTRACT] {len(files)} tiles → 2 layers (contours + numbers)")
    else:
        print(f"[EXTRACT] {len(files)} tiles → single combined layer")

    written_contours = []
    written_numbers = []
    for i, p in enumerate(files, 1):
        img = Image.open(p)
        if two_layer:
            contours_img, numbers_img = make_overlays(img)
        else:
            contours_img = make_overlay(img)
            numbers_img = None

        contours_name = p.stem + "_contours.png"
        contours_img.save(contours_dir / contours_name)

        if two_layer and numbers_img is not None:
            numbers_name = p.stem + "_numbers.png"
            numbers_img.save(numbers_dir / numbers_name)
            written_numbers.append(numbers_dir / numbers_name)

        side = p.with_suffix(".georef.json")
        if side.exists():
            try:
                gj = json.loads(side.read_text(encoding="utf-8"))
                gj["file"] = contours_name
                gj["layer"] = "contours"
                (contours_dir / (Path(contours_name).stem + ".georef.json")).write_text(
                    json.dumps(gj, indent=2), encoding="utf-8"
                )
            except Exception:
                shutil.copy2(side, contours_dir / (Path(contours_name).stem + ".georef.json"))

        if two_layer and numbers_img is not None and side.exists():
            try:
                gj = json.loads(side.read_text(encoding="utf-8"))
                gj["file"] = numbers_name
                gj["layer"] = "numbers"
                (numbers_dir / (Path(numbers_name).stem + ".georef.json")).write_text(
                    json.dumps(gj, indent=2), encoding="utf-8"
                )
            except Exception:
                shutil.copy2(side, numbers_dir / (Path(numbers_name).stem + ".georef.json"))

        written_contours.append(contours_dir / contours_name)
        if i % 10 == 0 or i == len(files):
            print(f"  {i}/{len(files)}")

    print(f"[EXTRACT] done — {len(written_contours)} contour overlays"
          + (f", {len(written_numbers)} number overlays" if two_layer else ""))
    return {"contours": written_contours, "numbers": written_numbers}


# ─────────────────────────────────────────────────────────────────────────────
# Chartpack packaging
# ─────────────────────────────────────────────────────────────────────────────

def package_chartpack(work_dir, chartpack_dir, job, two_layer=False):
    """Organize work_dir contents into a TrollMap-ready chartpack.

    Default (single layer):
        chartpack/
          contours/        ← one PNG per tile (lines + ALL numbers combined)
          raws/            ← original i-Boating tiles
          chartpack.json, capture_manifest.json, labels.geojson

    If two_layer=True:
        chartpack/
          contours/        ← lines + dark depth numbers
          numbers/         ← navy blue shallow depth numbers
          raws/
          ...
    """
    chartpack_dir = Path(chartpack_dir)
    if chartpack_dir.exists():
        shutil.rmtree(chartpack_dir)
    contours_dir = chartpack_dir / "contours"
    contours_dir.mkdir(parents=True, exist_ok=True)
    numbers_dir = chartpack_dir / "numbers" if two_layer else None
    if numbers_dir:
        numbers_dir.mkdir(parents=True, exist_ok=True)
    raws_dir = chartpack_dir / "raws"
    raws_dir.mkdir(parents=True, exist_ok=True)

    contours_src = work_dir / "contours"
    numbers_src = work_dir / "numbers"
    legacy_src = work_dir / "contour_overlay"  # backwards-compat with v5

    moved_contours = 0
    moved_numbers = 0

    # Contour overlays (combined if not two_layer).
    if contours_src.exists():
        for p in contours_src.glob("iboating_R*_C*_contours.png"):
            shutil.copy2(p, contours_dir / p.name)
            moved_contours += 1
        for p in contours_src.glob("iboating_R*_C*_contours.georef.json"):
            shutil.copy2(p, contours_dir / p.name)
    elif legacy_src.exists():
        for p in legacy_src.glob("iboating_R*_C*_contours.png"):
            shutil.copy2(p, contours_dir / p.name)
            moved_contours += 1
        for p in legacy_src.glob("iboating_R*_C*_contours.georef.json"):
            shutil.copy2(p, contours_dir / p.name)
    else:
        # No prior extract: run extract_contours into chartpack's dir.
        result = extract_contours(work_dir, contours_dir, two_layer=two_layer)
        moved_contours = len(result["contours"])
        moved_numbers = len(result["numbers"])

    if two_layer and numbers_src.exists():
        for p in numbers_src.glob("iboating_R*_C*_numbers.png"):
            shutil.copy2(p, numbers_dir / p.name)
            moved_numbers += 1
        for p in numbers_src.glob("iboating_R*_C*_numbers.georef.json"):
            shutil.copy2(p, numbers_dir / p.name)

    # Keep raws for re-extract / inspection.
    for p in work_dir.glob("iboating_R*_C*.png"):
        if "_contours" in p.stem or "_numbers" in p.stem:
            continue
        shutil.copy2(p, raws_dir / p.name)
    for p in work_dir.glob("iboating_R*_C*.georef.json"):
        shutil.copy2(p, raws_dir / p.name)

    # capture_manifest.json: copy and refresh.
    cap = work_dir / "capture_manifest.json"
    cap_data = {}
    if cap.exists():
        cap_data = json.loads(cap.read_text(encoding="utf-8"))
        cap_data["packaged_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        (chartpack_dir / "capture_manifest.json").write_text(
            json.dumps(cap_data, indent=2), encoding="utf-8"
        )

    # labels.geojson placeholder.
    placeholder_labels = {
        "type": "FeatureCollection",
        "_comment": (
            "Reserved for future OCR pipeline that would produce vector "
            "depth labels at exact lat/lon centroids. Today's chartpack "
            "already includes the blue shallow numbers as raster pixels."
        ),
        "features": [],
    }
    (chartpack_dir / "labels.geojson").write_text(
        json.dumps(placeholder_labels, indent=2), encoding="utf-8"
    )

    # Compute overall bbox.
    bounds = {"north": -90, "south": 90, "west": 180, "east": -180}
    bbox_sources = [contours_dir]
    if numbers_dir:
        bbox_sources.append(numbers_dir)
    for src in bbox_sources:
        for gj in src.glob("*.georef.json"):
            try:
                d = json.loads(gj.read_text(encoding="utf-8"))
                b = d.get("bounds") or d
                for k in ("north", "south", "west", "east"):
                    if k in b:
                        if k in ("north", "east"):
                            bounds[k] = max(bounds[k], float(b[k]))
                        else:
                            bounds[k] = min(bounds[k], float(b[k]))
            except Exception:
                continue

    if two_layer:
        chartpack = {
            "format": "trollmap-chartpack",
            "version": 3,
            "app": APP_VERSION,
            "name": job["name"],
            "source": "i-Boating",
            "source_url": job["source_url"],
            "bbox": job["_resolved"]["bbox"],
            "polygon": job["_resolved"]["polygon"],
            "zoom": job["_resolved"]["zoom"],
            "layers": {
                "contours": {
                    "tiles_dir": "contours",
                    "tile_count": moved_contours,
                    "description": (
                        "Gray contour lines + black/dark depth numbers. "
                        "Proven v5 extractor output."
                    ),
                },
                "numbers": {
                    "tiles_dir": "numbers",
                    "tile_count": moved_numbers,
                    "description": (
                        "Navy blue shallow-water depth numbers (RGB ~35,47,222). "
                        "Detected by color (r<=100, g<=100, b>=150, b-r>=100, "
                        "b-g>=100) and shape (compact digit clusters via "
                        "OpenCV connected components)."
                    ),
                },
            },
            "labels_file": "labels.geojson",
            "bounds": bounds,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "import_hint": (
                "In TrollMap: open 📂 Import Batch twice.\n"
                "  1) Select everything in chartpack/contours/  → adds N layers\n"
                "  2) Select everything in chartpack/numbers/   → adds N layers\n"
                "Toggle each layer's visibility independently."
            ),
        }
    else:
        chartpack = {
            "format": "trollmap-chartpack",
            "version": 3,
            "app": APP_VERSION,
            "name": job["name"],
            "source": "i-Boating",
            "source_url": job["source_url"],
            "bbox": job["_resolved"]["bbox"],
            "polygon": job["_resolved"]["polygon"],
            "zoom": job["_resolved"]["zoom"],
            "tile_count": moved_contours,
            "layers_combined": True,
            "description": (
                "Single-layer chartpack: each PNG in contours/ contains "
                "gray contour lines + black/dark depth numbers + navy blue "
                "shallow-water depth numbers, all in one transparent overlay. "
                "Drop the entire contours/ folder into TrollMap's 📂 Import "
                "Batch and you'll get lines AND numbers as one chart layer."
            ),
            "tiles_dir": "contours",
            "labels_file": "labels.geojson",
            "bounds": bounds,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "import_hint": (
                "In TrollMap: open 📂 Import Batch.\n"
                "Select everything in chartpack/contours/ → adds N chart layers.\n"
                "Each layer has lines AND numbers combined. Toggle each one off "
                "individually if needed."
            ),
        }
    (chartpack_dir / "chartpack.json").write_text(
        json.dumps(chartpack, indent=2), encoding="utf-8"
    )

    print(f"\n[PACKAGE] chartpack → {chartpack_dir}")
    print(f"  contours/ : {moved_contours} PNG + sidecars (lines + all numbers)")
    if two_layer:
        print(f"  numbers/  : {moved_numbers} PNG + sidecars (navy blue numbers)")
    print(f"  raws/     : original i-Boating tiles")
    print(f"  chartpack.json, capture_manifest.json, labels.geojson")
    print(f"  overall bbox: N{bounds['north']:.5f} S{bounds['south']:.5f} W{bounds['west']:.5f} E{bounds['east']:.5f}")
    return chartpack_dir


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def _build_argparser():
    ap = argparse.ArgumentParser(
        prog="trollmap_build_contours",
        description="Unified i-Boating → TrollMap chartpack pipeline.",
    )
    sub = ap.add_subparsers(dest="command", required=False)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--url", help="i-Boating URL with #zoom/lat/lon hash")
    common.add_argument("--north", type=float)
    common.add_argument("--south", type=float)
    common.add_argument("--west", type=float)
    common.add_argument("--east", type=float)
    common.add_argument(
        "--polygon",
        help="Polygon ring as 'lon,lat lon,lat ...' (overrides --bbox). "
             "Future versions will rasterize instead of bbox-expanding.",
    )
    common.add_argument("--job", help="Path to job.json")
    common.add_argument("--name", help="Chartpack name (default: derived)")
    common.add_argument("--zoom", type=float, help="Override URL zoom")
    common.add_argument("--out", help="Output chartpack folder")
    common.add_argument("--viewport", nargs=2, type=int, metavar=("W", "H"))
    common.add_argument("--overlap", type=float)
    common.add_argument("--wait", type=float)
    common.add_argument("--retries", type=int)
    common.add_argument("--water", type=float)
    common.add_argument("--contour-score", dest="contour_score", type=float)
    common.add_argument("--no-contour-check", action="store_true")
    common.add_argument("--crop", nargs=4, type=int, metavar=("L", "T", "R", "B"))
    common.add_argument("--headed", action="store_true")
    common.add_argument("--work-dir", help="Scratch dir for raw tiles (default: <out>_work)")

    p_build = sub.add_parser("build", parents=[common], help="capture + extract + package (default)")
    p_cap = sub.add_parser("capture", parents=[common], help="capture only")
    p_extract = sub.add_parser("extract", parents=[common], help="extract contours from existing work folder")
    p_pkg = sub.add_parser("package", parents=[common], help="package existing work folder into chartpack")
    return ap


def main(argv=None):
    # Allow bare invocation (`trollmap_build_contours.py --job foo.json`)
    # to default to the `build` subcommand.
    if argv is None:
        argv = sys.argv[1:]
    if argv and not argv[0].startswith("-") and argv[0] not in {"build", "capture", "extract", "package"}:
        argv = ["build"] + argv
    elif argv and argv[0].startswith("-"):
        argv = ["build"] + argv
    ap = _build_argparser()
    args = ap.parse_args(argv)
    cmd = args.command or "build"

    # For extract/package, job may be optional (operate on existing work_dir).
    if cmd in ("extract", "package"):
        if not args.out and not args.work_dir:
            raise SystemExit("extract/package need --work-dir (or --out as the work dir)")
        work_dir = Path(args.work_dir) if args.work_dir else Path(args.out)
        out_dir = Path(args.out) if args.out else None
        if cmd == "extract":
            extract_contours(work_dir)
            return
        if cmd == "package":
            # Need a job spec for chartpack metadata.
            job = load_job(args)
            package_chartpack(work_dir, out_dir or work_dir.parent / (work_dir.name + "_chartpack"), job)
            return

    # build / capture need a full job spec.
    job = load_job(args)
    out = Path(args.out) if args.out else Path(f"chartpack_{job['name']}")
    work_dir = Path(args.work_dir) if args.work_dir else Path(str(out) + "_work")
    work_dir.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)

    print(f"=== TrollMap Build Contours ({APP_VERSION}) — command: {cmd} ===")
    manifest = capture(job, work_dir)
    if cmd == "build" and job.get("extract_contours", True):
        extract_contours(work_dir)
    package_chartpack(work_dir, out, job)

    print("\n=== Done ===")
    print(f"Chartpack folder: {out}")
    print("To import into TrollMap: open 📂 Import Batch and select the contents of <chartpack>/contours/")
    print("Then hide the base map and the contours-only overlay will show through.")


if __name__ == "__main__":
    main()
