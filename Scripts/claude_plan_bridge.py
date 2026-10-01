#!/usr/bin/env python3
r"""claude_plan_bridge.py -- the app asks Claude on this PC to write the plan, on Ryan's subscription.

Personal use only, not for distribution or resale; not for navigation.

    py Scripts\claude_plan_bridge.py                 (sonnet, the same default as the research)
    py Scripts\claude_plan_bridge.py --model opus

Leave the window open. While it runs, Smart Plan, Pick Water and the Bench send their request here
instead of to the Worker's free Gemini chain; when it is not running they ask Gemini exactly as
before. Nothing else changes: the app builds the same request, reads the answer with the same
parser and runs the same checks on it.

WHY. Ryan, 2026-09-26: "i already pay for this so i might as well use it... my computer stays on
and connected to claude... i normally don't run plans from my phone... i plan here on the
computer". The research step made the same move on 2026-09-24 (claude_species.py) after the Murray
comparison: Lite wrote 5 quotes found in no document and 18 depths not in their own quote, Sonnet
0 and 0. The plan model's own record that week: a bait on a leg that `cannotUse` named, the reason
written under the wrong key, two answers the app could not parse, a 189-minute day for a 360-minute
window.

HOW. One `claude -p` per request, the same way claude_species.py calls it: no tools, no session
saved, no MCP, no CLAUDE.md (a temporary working folder), safe mode. The request's system prompt
goes in a file (`--system-prompt-file`) because Windows caps a command line at 32,767 characters;
the user prompt goes on stdin. The answer goes back in the same OpenAI shape the Worker's
/groq-query returns, so modelAsker's reader takes it unchanged.

WHO MAY CALL IT. It listens on 127.0.0.1 only, so nothing off this PC can reach it. A browser page
can, though, and any website open in the browser could try; so a request that carries an Origin is
answered only for the app's own origins (ALLOWED_ORIGINS). A request with no Origin is a program on
this PC, which could run `claude` itself anyway.

CHROME AND EDGE. A public https page calling 127.0.0.1 is a "local network access" request. The
browser asks once ("allow this site to access devices on your local network") and remembers the
answer. The preflight is answered with Access-Control-Allow-Private-Network for the browsers that
still use the older Private Network Access check.
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# The CLI lookup and the usage-limit words are the research step's, not a second copy of them.
from claude_species import DEFAULT_MODEL, _LIMIT_WORDS, claude_exe  # noqa: E402

# THE PORT. Any free loopback port would do; the app's CLAUDE_BRIDGE_URL (js/modules/claude-bridge.js)
# carries the same number, and the two must agree. Nothing on this PC listened on 8000-9999 on
# 2026-09-26; the catch-journal photo helper's default is 8787, so this is not that.
PORT = 8791

# The app is served from these. A preview deploy of trollmap-dev is <hash>.trollmap-dev.pages.dev.
ALLOWED_ORIGINS = re.compile(
    r"^(https://(trollmap-dev|trollmap)\.pages\.dev"
    r"|https://[a-z0-9-]+\.trollmap-dev\.pages\.dev"
    r"|https://colonal1981\.github\.io"
    r"|http://(127\.0\.0\.1|localhost)(:\d+)?)$")

# A DEADLINE FOR A HUNG PROCESS, NOT A TUNING KNOB -- the same meaning as claude_species.py's. The
# call's measured duration is printed and returned; this only has to outlast any answer that is
# going to arrive.
PLAN_TIMEOUT = 900

ASK = "Answer the request below with the one JSON object it asks for, and nothing else."

_one_at_a_time = threading.Lock()


def origin_allowed(origin):
    return origin is None or bool(ALLOWED_ORIGINS.match(origin))


def command(exe, model, system_file, effort=None):
    cmd = [exe, "-p", ASK, "--output-format", "json", "--model", model, "--tools", "",
           "--no-session-persistence", "--strict-mcp-config", "--safe-mode",
           "--system-prompt-file", system_file]
    if effort:
        cmd += ["--effort", effort]
    return cmd


def ask(system, user, model=DEFAULT_MODEL, effort=None, run=subprocess.run, timeout=PLAN_TIMEOUT):
    """(status, body). body is the OpenAI-shaped answer, or {"error", "usageLimit"}.
    `run` is injectable so the tests never start the CLI."""
    exe = claude_exe()
    if not exe:
        return 503, {"error": "claude CLI not found on this PC -- set TROLLMAP_CLAUDE_EXE, or "
                              "install Claude Code (it lands in ~/.local/bin)", "usageLimit": False}
    t0 = time.perf_counter()
    with tempfile.TemporaryDirectory() as cwd:        # no CLAUDE.md, no project settings
        sysf = os.path.join(cwd, "system.txt")
        with open(sysf, "w", encoding="utf-8") as f:
            f.write(system or "")
        try:
            p = run(command(exe, model, sysf, effort), input=user or "", capture_output=True,
                    text=True, encoding="utf-8", cwd=cwd, timeout=timeout)
        except subprocess.TimeoutExpired:
            return 504, {"error": f"claude did not answer within {timeout} s", "usageLimit": False}
    seconds = round(time.perf_counter() - t0, 1)
    try:
        out = json.loads(p.stdout or "")
    except json.JSONDecodeError:
        why = (p.stderr or p.stdout or "no output").strip()[:400]
        return 502, {"error": f"claude exit {p.returncode}: {why}",
                     "usageLimit": bool(_LIMIT_WORDS.search(why))}
    if out.get("is_error") or out.get("subtype") != "success":
        why = str(out.get("result") or out.get("subtype") or "error")[:400]
        return 502, {"error": f"claude: {why}", "usageLimit": bool(_LIMIT_WORDS.search(why))}
    return 200, to_openai(out, model, seconds)


def to_openai(out, model_asked, seconds):
    """The CLI's result, in the shape the Worker's /groq-query returns and modelAsker() reads."""
    u = out.get("usage") or {}
    mu = out.get("modelUsage") or {}
    prompt = sum(int(u.get(k) or 0) for k in
                 ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    completion = int(u.get("output_tokens") or 0)
    model = next(iter(mu), None) or model_asked
    return {
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": out.get("result") or ""}}],
        "model": model,
        "usage": {"prompt_tokens": prompt, "completion_tokens": completion,
                  "total_tokens": prompt + completion},
        "_trollmap": {"provider": "claude (this PC)", "model": model, "modelAsked": model_asked,
                      "seconds": seconds,
                      # What the same call would cost at API list price. NOT what the subscription
                      # charges; it is the one number the CLI gives for "how big was that".
                      "apiListPriceUsd": out.get("total_cost_usd")},
    }


class Handler(BaseHTTPRequestHandler):
    model = DEFAULT_MODEL
    effort = None
    runner = staticmethod(subprocess.run)

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

    def _send(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _refused(self):
        if origin_allowed(self.headers.get("Origin")):
            return False
        self._send(403, {"error": "this bridge answers only the TrollMap app"})
        return True

    def do_OPTIONS(self):                                           # noqa: N802
        if self._refused():
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):                                               # noqa: N802
        if self._refused():
            return
        if self.path.split("?")[0] != "/health":
            return self._send(404, {"error": "not found"})
        self._send(200, {"ok": True, "model": self.model, "effort": self.effort,
                         "claude": bool(claude_exe()), "busy": _one_at_a_time.locked()})

    def do_POST(self):                                              # noqa: N802
        if self._refused():
            return
        if self.path.split("?")[0] != "/ask":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return self._send(400, {"error": "the body is not JSON"})
        system, user = req.get("system"), req.get("user")
        if not isinstance(user, str) or not user.strip():
            return self._send(400, {"error": "no user prompt"})
        model = str(req.get("model") or self.model)
        # One at a time: a plan and its re-ask are sequential anyway, and two tabs building at once
        # would otherwise run two CLIs against one subscription.
        with _one_at_a_time:
            print(f"{time.strftime('%H:%M:%S')}  asking {model}: {len(system or '')} + {len(user)} "
                  f"characters", flush=True)
            status, body = ask(system, user, model, self.effort, run=self.runner)
        if status == 200:
            t = body["_trollmap"]
            print(f"{time.strftime('%H:%M:%S')}  answered by {t['model']} in {t['seconds']} s, "
                  f"{body['usage']['prompt_tokens']} in / {body['usage']['completion_tokens']} out",
                  flush=True)
        else:
            print(f"{time.strftime('%H:%M:%S')}  FAILED ({status}): {body['error']}", flush=True)
        self._send(status, body)

    def log_message(self, fmt, *args):     # the two lines above say what matters
        pass


class OneBridge(ThreadingHTTPServer):
    """ONE BRIDGE PER PORT. Measured 2026-10-01: two were running, one started 11:48 and one 3:21,
    both LISTENING on 127.0.0.1:8791 (netstat). http.server sets SO_REUSEADDR, and on Windows that
    lets a second process bind a port already in use, after which either one may answer and each
    keeps its own one-at-a-time lock. So the port is bound exclusively, and a second double-click
    says a bridge is already running instead of quietly becoming a second one."""
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):                  # Windows
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def serve(port=PORT, model=DEFAULT_MODEL, effort=None):
    Handler.model, Handler.effort = model, effort
    httpd = OneBridge(("127.0.0.1", port), Handler)
    return httpd


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--model", default=DEFAULT_MODEL, help="sonnet (default), opus, or a full name")
    ap.add_argument("--effort", default=None, help="low, medium, high, xhigh or max (CLI default)")
    ap.add_argument("--port", type=int, default=PORT)
    a = ap.parse_args(argv)
    if not claude_exe():
        print("claude CLI not found -- set TROLLMAP_CLAUDE_EXE, or install Claude Code.")
        return 1
    try:
        httpd = serve(a.port, a.model, a.effort)
    except OSError:
        print(f"A plan bridge is already running on http://127.0.0.1:{a.port}. Use that window; this "
              "one can be closed.", flush=True)
        return 1
    print(f"TrollMap plan bridge on http://127.0.0.1:{a.port} -- {a.model}"
          f"{' / effort ' + a.effort if a.effort else ''}. Leave this window open; Ctrl+C stops it.",
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
