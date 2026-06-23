#!/usr/bin/env python3
"""
TrollMap Capture Server — tiny localhost HTTP server that runs the
i-Boating contour pipeline on demand and serves the resulting chartpack
back to the TrollMap web UI.

Why: TrollMap can now export a polygon as job.json, POST it here, and the
whole capture+extract+package pipeline runs in the background. TrollMap
polls /status, shows live progress, and auto-imports the finished chartpack
with one click.

Endpoints
  GET  /status                          → current job state + progress
  GET  /list                            → list of completed chartpacks
  POST /capture   (body = job.json)     → start a new capture (rejects if running)
  GET  /chartpack/<name>/<rel-path>     → serve a file from the chartpack folder
  GET  /                                → tiny HTML status page (for debugging)

Run:
  py trollmap_capture_server.py [--port 8765] [--work-root .]

Stdlib only. No external deps.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


# ── State (single global, mutex-protected) ──────────────────────────────────

class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.status = "idle"          # idle | running | uploading | done | error
        self.job_name = None
        self.job = None               # full job dict
        self.start_ts = None
        self.end_ts = None
        self.tiles_saved = 0
        self.current_tile = None
        self.chartpack_url = None     # URL relative to /chartpack/
        self.upload_status = "skipped" # skipped | running | done | error
        self.upload_tiles = 0
        self.upload_total = 0
        self.upload_current = None
        self.upload_bytes = 0
        self.error = None
        self.process = None
        self.log_tail = []            # last ~40 stdout lines

state = State()


# ── Capture runner ──────────────────────────────────────────────────────────

_SAVE_RE = re.compile(r"R(\d{3})\s+C(\d{3}):\s+saved")


def run_capture(job, work_root, server_script_dir):
    """Spawn the build subprocess and stream progress into state."""
    name = job.get("name") or "trollmap_job"
    job_file = work_root / f"{name}.json"
    work_dir = work_root / f"{name}_work"
    chartpack_dir = work_root / f"{name}_chartpack"

    job_file.write_text(json.dumps(job, indent=2), encoding="utf-8")

    cmd = [
        sys.executable, "trollmap_build_contours.py", "build",
        "--job", str(job_file),
        "--work-dir", str(work_dir),
        "--out", str(chartpack_dir),
    ]

    with state.lock:
        state.status = "running"
        state.job = job
        state.job_name = name
        state.start_ts = time.time()
        state.end_ts = None
        state.tiles_saved = 0
        state.current_tile = None
        state.chartpack_url = None
        state.error = None
        state.log_tail = []
        state.process = None

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(server_script_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        with state.lock:
            state.process = proc

        for raw_line in proc.stdout:
            line = raw_line.rstrip()
            with state.lock:
                state.log_tail.append(line)
                if len(state.log_tail) > 40:
                    state.log_tail.pop(0)
            print(line, flush=True)
            m = _SAVE_RE.search(line)
            if m:
                with state.lock:
                    state.tiles_saved += 1
                    state.current_tile = f"R{m.group(1)}_C{m.group(2)}"

        proc.wait()
        with state.lock:
            state.end_ts = time.time()
            state.process = None
            if proc.returncode == 0:
                state.status = "done"
                state.chartpack_url = f"/chartpack/{name}/"
            else:
                state.status = "error"
                state.error = f"build script exited with code {proc.returncode}"
    except FileNotFoundError:
        with state.lock:
            state.status = "error"
            state.error = "could not find trollmap_build_contours.py (run server from its directory)"
            state.end_ts = time.time()
    except Exception as e:
        with state.lock:
            state.status = "error"
            state.error = f"{type(e).__name__}: {e}"
            state.end_ts = time.time()

    # ── Cloud upload (if configured) ──
    if CLOUD_WORKER and SYNC_TOKEN and Path(chartpack_dir).exists():
        with state.lock:
            state.status = "uploading"
            state.upload_status = "running"
            state.upload_total = 0
            state.upload_tiles = 0
            state.upload_bytes = 0
            state.upload_current = None
        try:
            upload_chartpack_to_cloud(chartpack_dir, name)
            with state.lock:
                state.upload_status = "done"
                state.status = "done"
        except Exception as e:
            with state.lock:
                state.upload_status = "error"
                state.status = "done"  # capture succeeded; upload failed (non-fatal)
                state.error = f"upload failed: {type(e).__name__}: {e}"


def upload_chartpack_to_cloud(chartpack_dir, lake_name):
    """Upload every tile + sidecar + chartpack.json from a chartpack folder
    to the Cloudflare worker via POST /chartpacks/<lake>/<file>."""
    import urllib.request

    contours = chartpack_dir / "contours"
    if not contours.exists():
        print(f"[upload] no contours/ dir in {chartpack_dir}, skipping")
        return

    files_to_upload = []
    # Contour tiles go under <lake>/contours/ — matches what TrollMap's import flow fetches.
    for p in sorted(contours.glob("*_contours.png")):
        stem = p.name.replace("_contours.png", "")
        files_to_upload.append((p, f"contours/{stem}_contours.png", "image/png"))
    for p in sorted(contours.glob("*_contours.georef.json")):
        stem = p.name.replace("_contours.georef.json", "")
        files_to_upload.append((p, f"contours/{stem}_contours.georef.json", "application/json"))
    cp_json = chartpack_dir / "chartpack.json"
    if cp_json.exists():
        files_to_upload.append((cp_json, "chartpack.json", "application/json"))

    with state.lock:
        state.upload_total = len(files_to_upload)
        state.upload_tiles = 0
        state.upload_bytes = 0

    print(f"[upload] {len(files_to_upload)} files -> {CLOUD_WORKER}/chartpacks/{lake_name}/")

    for src, fname, content_type in files_to_upload:
        with state.lock:
            state.upload_current = fname
        url = f"{CLOUD_WORKER.rstrip('/')}/chartpacks/{lake_name}/{fname}"
        try:
            data = src.read_bytes()
            req = urllib.request.Request(
                url,
                data=data,
                method="POST",
                headers={
                    "Content-Type": content_type,
                    "X-Sync-Token": SYNC_TOKEN,
                    "User-Agent": "TrollMap-Capture-Server/1.0",
                },
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                if resp.status >= 300:
                    raise RuntimeError(f"HTTP {resp.status}")
            with state.lock:
                state.upload_tiles += 1
                state.upload_bytes += len(data)
            print(f"[upload] {fname} ({len(data):,} bytes) ✓")
        except Exception as e:
            print(f"[upload] {fname} ✕ {e}")
            raise

    print(f"[upload] done — {state.upload_tiles}/{state.upload_total} files, "
          f"{state.upload_bytes:,} bytes")


# ── Helpers ──────────────────────────────────────────────────────────────────

def state_to_dict():
    with state.lock:
        elapsed = None
        if state.start_ts:
            end = state.end_ts or time.time()
            elapsed = round(end - state.start_ts, 1)
        return {
            "status": state.status,
            "job_name": state.job_name,
            "elapsed_seconds": elapsed,
            "tiles_saved": state.tiles_saved,
            "current_tile": state.current_tile,
            "chartpack_url": state.chartpack_url,
            "upload_status": state.upload_status,
            "upload_tiles": state.upload_tiles,
            "upload_total": state.upload_total,
            "upload_current": state.upload_current,
            "upload_bytes": state.upload_bytes,
            "error": state.error,
            "log_tail": list(state.log_tail),
        }


def list_chartpacks(work_root):
    out = []
    if not work_root.exists():
        return out
    for p in sorted(work_root.glob("*_chartpack")):
        if not p.is_dir():
            continue
        chartpack_json = p / "chartpack.json"
        meta = {}
        if chartpack_json.exists():
            try:
                meta = json.loads(chartpack_json.read_text(encoding="utf-8"))
            except Exception:
                pass
        # Count contour tiles.
        contours = p / "contours"
        tile_count = len(list(contours.glob("*.png"))) if contours.exists() else 0
        out.append({
            "name": p.name.replace("_chartpack", ""),
            "tile_count": tile_count,
            "created_at": meta.get("created_at"),
            "url_prefix": f"/chartpack/{p.name.replace('_chartpack', '')}/",
        })
    return out


# ── HTTP handler ─────────────────────────────────────────────────────────────

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "TrollMapCapture/1.0"

    def log_message(self, fmt, *args):
        # Quiet the default stderr access log; we print our own.
        pass

    def _send(self, status, body, content_type="application/json", extra_headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in CORS.items():
            self.send_header(k, v)
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)

        if path == "/" or path == "/index.html":
            self._send_html_status_page()
        elif path == "/status":
            self._send(200, state_to_dict())
        elif path == "/list":
            self._send(200, {"chartpacks": list_chartpacks(WORK_ROOT)})
        elif path.startswith("/chartpack/") and path.endswith("/index.json"):
            self._serve_chartpack_index(path[len("/chartpack/"):-len("/index.json")])
        elif path.startswith("/chartpack/"):
            self._serve_chartpack(path[len("/chartpack/"):])
        else:
            self._send(404, {"error": "not found", "path": path})

    def do_POST(self):
        url = urlparse(self.path)
        path = unquote(url.path)

        if path == "/capture":
            with state.lock:
                if state.status == "running":
                    self._send(409, {"error": "a capture is already running", "status": state_to_dict()})
                    return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length).decode("utf-8")
                job = json.loads(body)
            except Exception as e:
                self._send(400, {"error": f"bad json: {e}"})
                return

            threading.Thread(
                target=run_capture,
                args=(job, WORK_ROOT, SERVER_DIR),
                daemon=True,
            ).start()
            self._send(200, {"started": True, "job_name": job.get("name")})
        elif path == "/cancel":
            with state.lock:
                proc = state.process
            if proc and proc.poll() is None:
                proc.terminate()
                self._send(200, {"cancelled": True})
            else:
                self._send(400, {"error": "no running capture"})
        else:
            self._send(404, {"error": "not found", "path": path})

    def _serve_chartpack_index(self, name):
        # Return a JSON listing of tile basenames in this chartpack's contours/ folder.
        base = (WORK_ROOT / f"{name}_chartpack").resolve()
        contours = base / "contours"
        if not base.exists() or not contours.exists():
            self._send(404, {"error": "chartpack not found", "name": name})
            return
        stems = sorted({
            p.stem.replace("_contours", "")
            for p in contours.glob("*_contours.png")
        })
        self._send(200, {"name": name, "tiles": stems})

    def _serve_chartpack(self, rel):
        # rel = "<name>/<path-inside-chartpack>"
        # Resolve safely under WORK_ROOT.
        try:
            parts = rel.split("/", 1)
            if len(parts) < 2:
                self._send(400, {"error": "expected <name>/<path>"})
                return
            name, subpath = parts[0], parts[1]
            base = (WORK_ROOT / f"{name}_chartpack").resolve()
            target = (base / subpath).resolve()
            if not str(target).startswith(str(base)):
                self._send(403, {"error": "forbidden"})
                return
            if not target.exists() or not target.is_file():
                self._send(404, {"error": "file not found", "path": str(target)})
                return
            data = target.read_bytes()
            ct = "application/octet-stream"
            if target.suffix.lower() == ".png":
                ct = "image/png"
            elif target.suffix.lower() == ".json":
                ct = "application/json"
            elif target.suffix.lower() == ".geojson":
                ct = "application/geo+json"
            self._send(200, data, content_type=ct)
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def _send_html_status_page(self):
        s = state_to_dict()
        rows = "".join(f"<li>{esc(line)}</li>" for line in s["log_tail"])
        html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>TrollMap Capture Server</title>
<style>
  body {{ font-family: monospace; background:#0b1623; color:#e7eef6; padding:18px; max-width:900px }}
  h1 {{ color:#00e5ff }}
  .status-{{status}} {{ font-size: 22px; font-weight:700 }}
  .status-idle {{ color:#76ff03 }} .status-running {{ color:#ffb703 }}
  .status-done {{ color:#76ff03 }} .status-error {{ color:#ff5252 }}
  pre {{ background:#1a2b40; padding:10px; border-radius:6px; max-height:340px; overflow:auto }}
</style></head><body>
<h1>TrollMap Capture Server</h1>
<p>Status: <span class="status-{s['status']}">{s['status'].upper()}</span></p>
<p>Job: <b>{esc(s['job_name'] or '—')}</b> &nbsp; Elapsed: {s['elapsed_seconds'] or 0}s &nbsp;
   Tiles saved: {s['tiles_saved']} &nbsp; Current: {esc(s['current_tile'] or '—')}</p>
{f'<p style="color:#ff5252">Error: {esc(s["error"])}</p>' if s['error'] else ''}
<h2>Log tail</h2>
<pre><ul style="list-style:none;padding-left:0">{rows}</ul></pre>
</body></html>"""
        self._send(200, html, content_type="text/html; charset=utf-8")


def esc(s):
    return (str(s)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;"))


# ── Entry ────────────────────────────────────────────────────────────────────

# Cloud upload config — set via CLI args. Globals so upload_chartpack_to_cloud()
# can read them without threading them through.
CLOUD_WORKER = None
SYNC_TOKEN = None


def main():
    ap = argparse.ArgumentParser(description="TrollMap capture server (local).")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--work-root", default=None,
                    help="Where job.json / work / chartpack folders live. "
                         "Default: same dir as this script.")
    ap.add_argument("--cloud-worker", default=None,
                    help="Base URL of your Cloudflare worker, e.g. "
                         "https://trollmap-worker.colonal1981.workers.dev. "
                         "If set with --sync-token, finished captures auto-upload "
                         "their chartpack to the worker's R2 bucket.")
    ap.add_argument("--sync-token", default=None,
                    help="SYNC_TOKEN matching the worker Variable binding. "
                         "Required for uploads to be authorized.")
    args = ap.parse_args()

    global WORK_ROOT, SERVER_DIR, CLOUD_WORKER, SYNC_TOKEN
    SERVER_DIR = Path(__file__).resolve().parent
    WORK_ROOT = Path(args.work_root).resolve() if args.work_root else SERVER_DIR
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    CLOUD_WORKER = args.cloud_worker
    SYNC_TOKEN = args.sync_token

    print(f"[trollmap-capture-server] starting on http://{args.host}:{args.port}")
    print(f"[trollmap-capture-server] work root: {WORK_ROOT}")
    print(f"[trollmap-capture-server] build script: {SERVER_DIR / 'trollmap_build_contours.py'}")
    if CLOUD_WORKER:
        print(f"[trollmap-capture-server] cloud upload → {CLOUD_WORKER} (token {'set' if SYNC_TOKEN else 'MISSING'})")
    else:
        print(f"[trollmap-capture-server] cloud upload: disabled (pass --cloud-worker to enable)")
    print(f"[trollmap-capture-server] status page: http://{args.host}:{args.port}/")
    print(f"[trollmap-capture-server] Press Ctrl-C to stop.\n")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[trollmap-capture-server] shutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()
