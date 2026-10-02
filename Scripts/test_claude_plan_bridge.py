#!/usr/bin/env python3
r"""test_claude_plan_bridge.py -- the plan bridge answers only the app, in the Worker's shape.

    py .\Scripts\test_claude_plan_bridge.py

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-09-26: "i already pay for this so i might as well use it". These hold
claude_plan_bridge.py to: the system prompt goes in a file and never on the command line (Windows
caps a command line at 32,767 characters and the plan's prompt is ~95,000); the answer comes back
in the OpenAI shape modelAsker() already reads; a usage limit is said as one; a page from any other
site gets nothing; and the browser's local-network preflight is answered. No CLI is started --
`run` is stubbed, and the server test runs on a free port with a stub runner.
"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claude_plan_bridge as B                                  # noqa: E402

OK_OUT = {"type": "result", "subtype": "success", "is_error": False,
          "result": '{"legs": []}', "total_cost_usd": 0.39, "duration_api_ms": 70000,
          "usage": {"input_tokens": 12, "cache_creation_input_tokens": 30000,
                    "cache_read_input_tokens": 11000, "output_tokens": 22000},
          "modelUsage": {"claude-sonnet-5": {}}}


class Proc:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout, self.stderr, self.returncode = stdout, stderr, returncode


def runner(out=None, stderr="", rc=0, seen=None):
    def run(cmd, **kw):
        if seen is not None:
            with open(cmd[cmd.index("--system-prompt-file") + 1], encoding="utf-8") as f:
                seen.append({"cmd": cmd, **kw, "system": f.read()})
        return Proc(json.dumps(out) if out is not None else "", stderr, rc)
    return run


class Ask(unittest.TestCase):
    def setUp(self):
        self._exe = B.claude_exe
        B.claude_exe = lambda: "claude.exe"

    def tearDown(self):
        B.claude_exe = self._exe

    def test_the_system_prompt_goes_in_a_file_and_the_user_prompt_on_stdin(self):
        seen = []
        big = "S" * 95000
        st, body = B.ask(big, "plan it", "sonnet", run=runner(OK_OUT, seen=seen))
        self.assertEqual(st, 200)
        cmd = seen[0]["cmd"]
        self.assertNotIn(big, cmd)
        self.assertEqual(seen[0]["system"], big)
        self.assertEqual(seen[0]["input"], "plan it")
        for flag in ("-p", "--no-session-persistence", "--strict-mcp-config", "--safe-mode"):
            self.assertIn(flag, cmd)
        self.assertEqual(cmd[cmd.index("--tools") + 1], "")
        self.assertEqual(cmd[cmd.index("--model") + 1], "sonnet")

    def test_the_answer_comes_back_in_the_workers_shape(self):
        st, body = B.ask("s", "u", "sonnet", run=runner(OK_OUT))
        self.assertEqual(body["choices"][0]["message"]["content"], '{"legs": []}')
        self.assertEqual(body["choices"][0]["finish_reason"], "stop")
        self.assertEqual(body["model"], "claude-sonnet-5")
        self.assertEqual(body["usage"]["prompt_tokens"], 41012)
        self.assertEqual(body["usage"]["completion_tokens"], 22000)
        self.assertEqual(body["_trollmap"]["provider"], "claude (this PC)")

    def test_a_usage_limit_is_said_as_one(self):
        out = dict(OK_OUT, is_error=True, subtype="error", result="You've hit your weekly limit")
        st, body = B.ask("s", "u", run=runner(out))
        self.assertEqual(st, 502)
        self.assertTrue(body["usageLimit"])

    def test_a_crash_is_an_error_not_an_answer(self):
        st, body = B.ask("s", "u", run=runner(None, stderr="boom", rc=1))
        self.assertEqual(st, 502)
        self.assertIn("boom", body["error"])
        self.assertFalse(body["usageLimit"])

    def test_no_cli_is_a_503(self):
        B.claude_exe = lambda: None
        st, body = B.ask("s", "u", run=runner(OK_OUT))
        self.assertEqual(st, 503)


class Origins(unittest.TestCase):
    def test_the_apps_origins_and_nothing_else(self):
        for o in ("https://trollmap-dev.pages.dev", "https://trollmap.pages.dev",
                  "https://abc123.trollmap-dev.pages.dev", "https://colonal1981.github.io",
                  "http://127.0.0.1:8765", "http://localhost:3000", None):
            self.assertTrue(B.origin_allowed(o), o)
        for o in ("https://evil.example", "https://trollmap-dev.pages.dev.evil.example",
                  "http://192.168.1.5", "null"):
            self.assertFalse(B.origin_allowed(o), o)


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._exe = B.claude_exe
        B.claude_exe = lambda: "claude.exe"
        B.Handler.runner = staticmethod(runner(OK_OUT))
        cls.httpd = B.serve(0, "sonnet")
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        B.claude_exe = cls._exe

    def req(self, method, path, origin=None, body=None):
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                   data=json.dumps(body).encode() if body is not None else None)
        if origin:
            r.add_header("Origin", origin)
        if body is not None:
            r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r, timeout=10) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_the_browsers_preflight_is_answered_for_the_app(self):
        st, h, _ = self.req("OPTIONS", "/ask", "https://trollmap-dev.pages.dev")
        self.assertEqual(st, 204)
        self.assertEqual(h["Access-Control-Allow-Origin"], "https://trollmap-dev.pages.dev")
        self.assertEqual(h["Access-Control-Allow-Private-Network"], "true")

    def test_another_site_gets_nothing(self):
        st, h, _ = self.req("POST", "/ask", "https://evil.example", {"system": "s", "user": "u"})
        self.assertEqual(st, 403)
        self.assertNotIn("Access-Control-Allow-Origin", h)

    def test_health_and_an_answer(self):
        st, _, b = self.req("GET", "/health", "https://trollmap-dev.pages.dev")
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(b)["model"], "sonnet")
        st, h, b = self.req("POST", "/ask", "https://trollmap-dev.pages.dev", {"system": "s", "user": "u"})
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(b)["choices"][0]["message"]["content"], '{"legs": []}')
        self.assertEqual(h["Access-Control-Allow-Origin"], "https://trollmap-dev.pages.dev")

    def test_a_request_may_name_its_effort_and_nothing_else_gets_through(self):
        # 2026-10-02: the planner's re-ask hands Claude its own answer back and asks at "low".
        seen = []
        B.Handler.runner = staticmethod(runner(OK_OUT, seen=seen))
        try:
            st, _, b = self.req("POST", "/ask", None, {"system": "s", "user": "u", "effort": "low"})
            self.assertEqual(st, 200)
            cmd = seen[-1]["cmd"]
            self.assertEqual(cmd[cmd.index("--effort") + 1], "low")
            self.assertEqual(json.loads(b)["_trollmap"]["effort"], "low")
            # Not a level the CLI takes: the bridge's own setting stands (none, here).
            st, _, b = self.req("POST", "/ask", None, {"system": "s", "user": "u", "effort": "--rm"})
            self.assertEqual(st, 200)
            self.assertNotIn("--effort", seen[-1]["cmd"])
            self.assertIsNone(json.loads(b)["_trollmap"]["effort"])
        finally:
            B.Handler.runner = staticmethod(runner(OK_OUT))

    def test_an_empty_prompt_is_refused(self):
        st, _, _ = self.req("POST", "/ask", None, {"system": "s", "user": ""})
        self.assertEqual(st, 400)

    def test_a_second_bridge_on_the_same_port_is_refused(self):
        # 2026-10-01: two bridges were LISTENING on 8791 at once. The second must fail to bind.
        with self.assertRaises(OSError):
            B.serve(self.port, "sonnet")


if __name__ == "__main__":
    unittest.main(verbosity=2)
