"""End-to-end checks for the built csuper CLI.

Runs `dist/csuper.js dash` in a real pty (rendered with pyte) against demo
daemons from scripts/demo-daemon.ts, plus the one-shot `status` exit codes.
Everything runs under a throwaway CSUPER_HOME, so ~/.csuper is never touched.

    npm run test:e2e              # builds, sets up .cache/e2e-venv, runs all suites
    npm run test:e2e -- -v        # also print screen frames
    npm run test:e2e -- reconnect # run only the named suites

Set CSUPER_E2E_BIN=$(which csuper) to drive an installed/linked `csuper` instead
of dist/csuper.js, and CSUPER_E2E_CWD to run it from another directory.
CSUPER_E2E_KEEP=1 keeps the throwaway home (logs, tab output) for debugging.

Suites: keys, reconnect, switch, status, supervisor, autopilot, resume, adopt
Opt-in: real (CSUPER_E2E_REAL=1) — one smoke test with the real `claude` on haiku.
Costs a few cents of quota, so it never runs as part of `npm test` or by default.
"""
import fcntl
import json
import os
import pty
import re
import select
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import traceback

import pyte

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = os.path.join(REPO, "dist", "csuper.js")
DEMO = os.path.join(REPO, "scripts", "demo-daemon.ts")
# Command used to invoke the CLI under test, and the directory it runs in.
BIN = [os.environ["CSUPER_E2E_BIN"]] if os.environ.get("CSUPER_E2E_BIN") else ["node", CLI]
CLI_CWD = os.environ.get("CSUPER_E2E_CWD", REPO)
COLS, ROWS = 120, 42
VERBOSE = "-v" in sys.argv

# Short path on purpose: macOS caps Unix socket paths at 104 bytes.
HOME = tempfile.mkdtemp(prefix="cse", dir="/tmp")
ENV = {**os.environ, "CSUPER_HOME": HOME, "TERM": "xterm-256color", "COLUMNS": str(COLS), "LINES": str(ROWS)}
# The supervisor runs a scripted stand-in for claude, and resume reads a fake
# Claude Code config dir: the suite never touches the real ~/.claude.
ENV["CSUPER_CLAUDE_BIN"] = os.path.join(REPO, "tests", "e2e", "fake-claude.mjs")
ENV["CLAUDE_CONFIG_DIR"] = os.path.join(HOME, "cc")
# Registry only: the real claudes on this machine aren't in the fake ~/.claude.
ENV["CSUPER_CLAUDE_SCAN"] = "off"
# New tabs (csuper adopt --tabs) become detached ptys logging to HOME/tabs.
ENV["CSUPER_TAB_LAUNCHER"] = os.path.join(REPO, "tests", "e2e", "fake-tab.py")
ENV["FAKE_TAB_DIR"] = os.path.join(HOME, "tabs")
# As if csuper were started from inside a Claude Code session: these must not reach claude.
ENV["CLAUDECODE"] = "1"
ENV["CLAUDE_CODE_CHILD_SESSION"] = "1"
ENV.pop("CSUPER_SESSION", None)
ENV.pop("CSUPER_SESSION_SOCK", None)
ENV.pop("NO_COLOR", None)

results = []  # (suite, name, ok)
current_suite = ""


def check(name, cond):
    ok = bool(cond)
    results.append((current_suite, name, ok))
    print(("  PASS " if ok else "  FAIL ") + name, flush=True)
    return ok


# ---------------------------------------------------------------- daemons


class Demo:
    """A simulated supervisor session (scripts/demo-daemon.ts)."""

    def __init__(self, sid, scenario="ok"):
        self.sid = sid
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", DEMO, "--id", sid, "--scenario", scenario],
            cwd=REPO,
            env=ENV,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        json_path = os.path.join(HOME, "sessions", f"{sid}.json")
        end = time.time() + 15
        while time.time() < end and not os.path.exists(json_path):
            if self.proc.poll() is not None:
                raise RuntimeError(f"demo {sid} exited: {self.proc.stderr.read().decode()}")
            time.sleep(0.05)
        if not os.path.exists(json_path):
            raise RuntimeError(f"demo {sid} did not register within 15s")

    def stop(self, sig=signal.SIGTERM):
        if self.proc.poll() is None:
            self.proc.send_signal(sig)
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


demos = []


def demo(sid, scenario="ok"):
    d = Demo(sid, scenario)
    demos.append(d)
    return d


def stop_all_demos():
    for d in demos:
        d.stop()
    demos.clear()


def run_cli(*args, env=None, timeout=20):
    p = subprocess.run([*BIN, *args], cwd=CLI_CWD, env=env or ENV, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr


# ---------------------------------------------------------------- dashboard in a pty


class Dash:
    """Any csuper command in a pty (`dash` unless cmd= says otherwise)."""

    def __init__(self, *args, cmd=("dash",), argv=None, cwd=None, env=None):
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = bytearray()
        argv = argv or [*BIN, *cmd, *args]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd or CLI_CWD)
            os.execvpe(argv[0], argv, env or ENV)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.status = None

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)

    def wait_exit(self, t=8):
        end = time.time() + t
        while time.time() < end:
            self.pump(0.1)
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.pump(0.2)
                self.status = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
                return self.status
        return None

    def pump(self, t):
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                self.raw.extend(data)
                self.stream.feed(data)

    def text(self):
        return "\n".join(line.rstrip() for line in self.screen.display)

    def wait_for(self, s, t=6):
        end = time.time() + t
        while time.time() < end:
            self.pump(0.1)
            if s in self.text():
                return True
        return False

    def wait_gone(self, s, t=6):
        end = time.time() + t
        while time.time() < end:
            self.pump(0.1)
            if s not in self.text():
                return True
        return False

    def key(self, k, expect=None, settle=0.6):
        os.write(self.fd, k)
        if expect:
            return self.wait_for(expect)
        self.pump(settle)
        return True

    def type(self, s):
        for ch in s.encode():
            os.write(self.fd, bytes([ch]))
            self.pump(0.03)

    def show(self, title):
        if VERBOSE:
            print(f"\n===== {title} =====\n{self.text()}\n", flush=True)

    def quit(self):
        os.write(self.fd, b"q")
        self.pump(1.5)
        _, status = os.waitpid(self.pid, 0)
        self.status = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
        return self.status

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


# ---------------------------------------------------------------- suites


def suite_keys():
    """Every keybinding against one live demo session."""
    demo("a1a1a1")
    d = Dash()
    try:
        check("connected + panels", d.wait_for("● CONNECTED") and d.wait_for("6 Log Stream") and d.wait_for("3 Cycles") and d.wait_for("cycles 0/20"))
        d.pump(1.0)
        d.show("initial")

        check("p pauses", d.key(b"p", "PAUSED"))
        check("p resumes", d.key(b"p", "✓ autopilot.resume"))

        # "/clear /next in" only appears in the countdown row (the status bar also says "c cancel").
        check("countdown appears", d.wait_for("/clear /next in", 12))
        d.show("countdown pending")
        check("countdown hint visible", "· c cancel (task_comp" in d.text())
        check("c cancels", d.key(b"c", "✓ countdown.cancel"))

        check("f -> warn+", d.key(b"f", "level warn+"))
        check("f -> error", d.key(b"f", "level error"))
        check("f -> all", d.key(b"f", "level all"))
        d.key(b"f", "level info+")

        d.key(b"/")
        d.type("checkpoint")
        check("text filter", d.wait_for("/checkpoint"))
        d.key(b"\r", settle=0.5)
        d.key(b"/", settle=0.3)
        d.key(b"\x1b", settle=0.6)
        check("Esc clears filter", "/checkpoint" not in d.text())

        check("l fullscreen", d.key(b"l", "esc to exit"))
        d.show("log fullscreen")
        check("Esc leaves fullscreen", d.key(b"\x1b", "Rate Limits"))

        check("h hides handover", d.key(b"h", "preview hidden (h)"))
        d.key(b"h", settle=0.5)

        check("s switcher", d.key(b"s", "Switch session"))
        d.key(b"\x1b", settle=0.5)

        check("rate limit wait shows", d.wait_for("waiting", 45))
        check("w asks y/N", d.key(b"w", "[y/N]"))
        check("y skips wait", d.key(b"y", "✓ ratelimit.skip_wait"))

        check("? help", d.key(b"?", "csuper dash — keys"))
        d.key(b"x", settle=0.4)

        check("q exits 0", d.quit() == 0)
        check(
            "terminal restored (left alt screen)",
            d.raw.rfind(b"\x1b[?1049l") > d.raw.rfind(b"\x1b[?1049h") >= 0,
        )
    finally:
        if d.status is None:
            d.show("last frame")
            d.kill()
        stop_all_demos()
    check("registry empty after demo teardown", os.listdir(os.path.join(HOME, "sessions")) == [])


def suite_reconnect():
    """Daemon goes away and comes back on the same socket → DISCONNECTED, then a fresh snapshot."""
    first = demo("b2b2b2")
    d = Dash()
    try:
        check("connected", d.wait_for("● CONNECTED") and d.wait_for("b2b2b2"))
        check("pause before restart", d.key(b"p", "PAUSED"))

        first.stop()
        check("shows DISCONNECTED banner", d.wait_for("DISCONNECTED", 6))
        check("keeps last known state while down", "PAUSED" in d.text() and "b2b2b2" in d.text())
        d.show("disconnected")
        # A control action while disconnected must fail cleanly, not crash.
        check("control while down fails cleanly", d.key(b"p", "not connected"))

        time.sleep(2)  # let the backoff grow a little
        demo("b2b2b2")  # restarted daemon starts with autopilot ON
        check("reconnects", d.wait_gone("DISCONNECTED", 15) and d.wait_for("● CONNECTED", 5))
        d.pump(1.0)
        d.show("reconnected")
        check("fresh snapshot after reconnect (autopilot ON again)", "PAUSED" not in d.text() and "ON" in d.text())
        check("controls work after reconnect", d.key(b"p", "✓ autopilot.pause"))
        check("q exits 0", d.quit() == 0)
    finally:
        if d.status is None:
            d.show("last frame")
            d.kill()
        stop_all_demos()


def suite_switch():
    """Two live sessions: picker on start, then `s` to switch between them."""
    demo("c3c3c3", "ok")
    demo("d4d4d4", "paused")
    d = Dash()
    try:
        check("picker shown with 2 live sessions", d.wait_for("Pick a csuper session") and d.wait_for("d4d4d4"))
        d.show("picker")
        d.key(b"\r")
        check("opens first session", d.wait_for("● CONNECTED") and d.wait_for("c3c3c3"))
        check("first session autopilot ON", d.wait_gone("PAUSED", 3))

        check("s opens switcher", d.key(b"s", "Switch session"))
        check("current session marked", "c3c3c3" in d.text() and "(current)" in d.text())
        d.key(b"\x1b[B", settle=0.3)  # down arrow
        d.key(b"\r")
        check("switched to second session", d.wait_for("d4d4d4") and d.wait_gone("c3c3c3", 4))
        check("second session state shown (PAUSED)", d.wait_for("PAUSED"))
        d.show("second session")

        d.key(b"s", "Switch session")
        d.key(b"\x1b[A", settle=0.3)  # up arrow
        d.key(b"\r")
        check("switched back to first session", d.wait_for("c3c3c3") and d.wait_gone("d4d4d4", 4))
        check("first session state shown again", d.wait_gone("PAUSED", 4))
        check("q exits 0", d.quit() == 0)
    finally:
        if d.status is None:
            d.show("last frame")
            d.kill()
        stop_all_demos()


def suite_status():
    """`csuper status` exit codes 0–4 (docs/dashboard-spec.md §4.3)."""

    def expect(label, want, *args):
        code, out = run_cli("status", *args)
        ok = check(f"{label} → exit {want}", code == want)
        if not ok or VERBOSE:
            print(f"    got exit {code}: {out.strip()[:300]}")

    expect("no session", 2)
    expect("unknown --session", 2, "--session", "ffffff")

    d = demo("e5e5e5", "ok")
    expect("running, autopilot on", 0)
    code, out = run_cli("status", "--json")
    check("--json is the snapshot", code == 0 and '"id": "e5e5e5"' in out)
    d.stop()

    for sid, scenario, want in [("e5e5e6", "paused", 1), ("e5e5e7", "waiting", 1), ("e5e5e8", "anomaly", 3)]:
        d = demo(sid, scenario)
        expect(f"{scenario}", want)
        d.stop()

    a, b = demo("f6f6f6"), demo("f7f7f7")
    expect("two live sessions, no --session", 2)
    expect("two live sessions, --session given", 0, "--session", "f6f6f6")
    a.stop()
    b.stop()

    stale = demo("f8f8f8")
    stale.stop(signal.SIGKILL)  # no teardown: socket + json stay behind
    expect("stale (daemon killed)", 4, "--session", "f8f8f8")
    code, out = run_cli("sessions", "--prune")
    check("sessions --prune removes it", code == 0 and not os.path.exists(os.path.join(HOME, "sessions", "f8f8f8.json")))
    expect("after prune", 2, "--session", "f8f8f8")
    demos.clear()


def status_json():
    code, out = run_cli("status", "--json")
    try:
        return code, json.loads(out)
    except ValueError:
        return code, None


def wait_status(want, t=5):
    end = time.time() + t
    while time.time() < end:
        code, _ = run_cli("status")
        if code == want:
            return True
        time.sleep(0.15)
    return False


def suite_supervisor():
    """`csuper [claude-args]`: claude in a pty, registry, Ctrl+G, ctl, hooks, exit code."""
    t = Dash("--model", "sonnet", "hello", cmd=())
    check("claude starts in the pty", t.wait_for("READY", 10))
    t.show("supervisor started")
    out = t.text()
    check("claude gets csuper's hook settings, then the user's args",
          'args=["--settings","<json>","--model","sonnet","hello"]' in out.replace("\n", ""))
    check("CSUPER_SESSION_SOCK is set for hooks", "SOCK=set" in out)
    sid = out.split("SESSION=")[1][:6] if "SESSION=" in out else ""
    check("CSUPER_SESSION is the csuper session id", len(sid) == 6)
    check("Claude Code session markers are stripped (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION)", "CHILD=unset CLAUDECODE=unset" in out)

    code, out = run_cli("sessions")
    check("`csuper sessions` lists it as live", code == 0 and sid in out and "live" in out)
    code, st = status_json()
    check("status → exit 0 (running)", code == 0)
    check("status --json: model and claude pid", st and st["model"] == "sonnet" and st["session"]["claudePid"] > 0)
    check("config limits reach the snapshot: cycles 0/20, tool-fail threshold 5",
          st and st["cycles"]["used"] == 0 and st["cycles"]["max"] == 20 and st["anomalies"]["threshold"] == 5)

    t.key(b"\x07")
    check("Ctrl+G pauses autopilot → status exit 1", wait_status(1))
    code, st = status_json()
    check("paused by user", st and st["autopilot"]["pausedReason"] == "user")
    t.key(b"\x07")
    check("Ctrl+G again resumes → exit 0", wait_status(0))

    code, _ = run_cli("ctl", "pause")
    check("`csuper ctl pause` acked", code == 0 and wait_status(1))
    code, _ = run_cli("ctl", "resume")
    check("`csuper ctl resume` acked", code == 0 and wait_status(0))
    code, out = run_cli("ctl", "cancel-countdown")
    check("cancel-countdown with nothing pending is refused", code != 0 and "no countdown" in out)

    t.type("fail\r")
    check("hook runs inside claude and exits 0", t.wait_for("HOOK-SENT Bash exit=0", 6))
    t.type("fail\r")
    t.wait_for("HOOK-SENT Bash exit=0\n", 1)
    time.sleep(0.4)
    _, st = status_json()
    check("two failed tools → failure streak 2", st and st["anomalies"]["toolFailureStreak"] == 2)
    t.type("ok\r")
    time.sleep(0.8)
    _, st = status_json()
    check("a successful tool resets the streak", st and st["anomalies"]["toolFailureStreak"] == 0)
    t.type("edit\r")
    time.sleep(0.5)
    t.type("edit\r")
    time.sleep(0.8)
    _, st = status_json()
    check("same file edited twice → edit thrash src/a.ts×2", st and st["anomalies"]["editThrash"] == {"src/a.ts": 2})

    for _ in range(5):
        t.type("fail\r")
        time.sleep(0.35)
    time.sleep(0.6)
    code, st = status_json()
    check("5 failed tools in a row → breaker trips, autopilot paused (exit 3)",
          code == 3 and st and st["autopilot"] == {"enabled": False, "pausedReason": "breaker"})
    t.type("ok\r")
    time.sleep(0.5)
    run_cli("ctl", "resume")
    check("`csuper ctl resume` clears the breaker", wait_status(0))

    code, out = run_cli("logs", "--raw")
    check("log has tool.failed, breaker.tripped and autopilot.toggled",
          '"tool.failed"' in out and '"breaker.tripped"' in out and '"autopilot.toggled"' in out)

    t.resize(100, 30)
    time.sleep(0.3)
    t.type("size\r")
    check("terminal resize reaches claude", t.wait_for("SIZE=100x30", 4))
    t.resize(COLS, ROWS)

    t.type("quit 3\r")
    code = t.wait_exit()
    t.show("after claude exit")
    check("csuper exits with claude's exit code (3)", code == 3)
    check("prints that the session ended", f"session {sid} ended" in t.text())
    check("session removed from the registry",
          not os.path.exists(os.path.join(HOME, "sessions", f"{sid}.json")) and not os.path.exists(os.path.join(HOME, "sessions", f"{sid}.sock")))

    hook = os.path.join(REPO, "dist", "hooks", "csuper-hook.js")
    env = {k: v for k, v in ENV.items() if k != "CSUPER_SESSION_SOCK"}
    p = subprocess.run(["node", hook], input='{"hook_event_name":"PostToolUse"}', env=env, capture_output=True, text=True, timeout=5)
    check("hook outside csuper: silent no-op, exit 0", p.returncode == 0 and p.stdout == "" and p.stderr == "")


def suite_autopilot():
    """Autopilot through the real hook path: DONE → checked /clear → /next cycle, an unconfirmed /clear, usage limits (resume, still limited, Opus failover)."""
    proj = tempfile.mkdtemp(prefix="csp", dir="/tmp")
    git = lambda *a: subprocess.run(["git", "-C", proj, *a], capture_output=True, text=True)
    git("init", "-q")
    git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init")
    git("config", "user.email", "e2e@example.invalid")
    git("config", "user.name", "e2e")
    with open(os.path.join(proj, "work.txt"), "w") as f:
        f.write("uncommitted work\n")
    cfg = os.path.join(HOME, "autopilot.yaml")
    with open(cfg, "w") as f:
        f.write("pre_clear_delay_ms: 700\n"
                "autopilot: {cycle_step_timeout_ms: 2500, idle_quiet_ms: 300}\n"
                "rate_limits: {reset_margin_seconds: 90, resume_verify_seconds: 5, pty_fallback_grace_ms: 1000}\n")
    notes = os.path.join(HOME, "notifications.jsonl")
    env = {**ENV, "CSUPER_CONFIG": cfg, "CSUPER_NOTIFY_LOG": notes}
    t = Dash(cmd=(), cwd=proj, env=env)
    check("claude starts", t.wait_for("READY", 10))

    def st():
        _, s = status_json()
        return s or {}

    def until(cond, secs=10):
        end = time.time() + secs
        while time.time() < end:
            t.pump(0.15)
            s = st()
            if s and cond(s):
                return s
        return st()

    out = t.text()
    t.type("done\r")
    s = until(lambda s: s["cycles"]["current"] is not None)
    check("::DONE:: (Stop hook) starts a cycle with a countdown", s.get("cycles", {}).get("current", {}).get("name") in ("done_detected", "countdown"))
    s = until(lambda s: s["cycles"]["used"] == 1, 12)
    check("cycle completes: cycles 1/20", s["cycles"]["used"] == 1 and s["cycles"]["current"] is None)
    t.pump(1.0)
    out = t.text()
    check("/clear then /next were typed into claude", "GOT /clear" in out and "GOT /next" in out and out.index("GOT /clear") < out.index("GOT /next"))
    rec = (s["cycles"]["recent"] or [{}])[-1]
    check("cycle result ok", rec.get("result") == "ok")
    s = until(lambda s: s["cycles"]["recent"][-1].get("phase"), 5)
    check("phase read from /next's reply", s["cycles"]["recent"][-1].get("phase") == "2: Wiring")
    _, logs = run_cli("logs", "--raw", "--event", "cycle.step", "-n", "100")
    steps = [json.loads(l)["data"] for l in logs.splitlines() if l.startswith("{")]
    oks = [f'{d["n"]}/{d["total"]} {d["step"]}' for d in steps if d.get("status") == "ok" and d.get("cycle") == 1]
    check("8 steps, each confirmed and logged as JSONL",
          oks == ["1/8 done_detected", "2/8 countdown", "3/8 clear_sent", "4/8 clear_confirmed", "5/8 idle", "6/8 next_sent", "7/8 turn_confirmed", "8/8 done"])
    log = git("log", "--oneline").stdout
    check("git checkpoint committed the dirty tree", "chore(csuper): checkpoint (task_complete)" in log)
    check("status --json has the checkpoint (only the project's file, not csuper's handover copy)", (s.get("git", {}).get("lastCheckpoint") or {}).get("files") == 1)
    handovers = os.path.join(proj, ".claude", "csuper-handovers")
    check("handover saved", os.path.isdir(handovers) and any(n.endswith("task_complete.md") for n in os.listdir(handovers)))

    # /clear that is never confirmed → fails at step 4, pauses, notifies; no retry.
    t.type("noclear\r")
    t.wait_for("NOCLEAR=true", 3)
    t.type("done\r")
    s = until(lambda s: s["cycles"]["failed"] == 1, 12)
    check("unconfirmed /clear fails the cycle at clear_confirmed", s["cycles"]["recent"][-1].get("result") == "failed" and s["cycles"]["recent"][-1].get("step") == "clear_confirmed")
    check("autopilot paused (cycle_failed), status exit 3", s["autopilot"] == {"enabled": False, "pausedReason": "cycle_failed"} and run_cli("status")[0] == 3)
    t.pump(3)
    check("no retry: /next never typed after the failure", t.text().count("GOT /next") == 1 and st()["cycles"]["failed"] == 1)
    n = open(notes).read() if os.path.exists(notes) else ""
    check("you were notified", "cycle failed" in n and "clear_confirmed" in n)
    t.type("noclear\r")
    run_cli("ctl", "resume")
    check("ctl resume clears it", wait_status(0))

    # Usage limit → wait with caffeinate → skip-wait resumes and verifies.
    reset = time.strftime("%I:%M%p", time.localtime(time.time() + 2 * 3600)).lstrip("0").lower()
    t.type(f"limit You've hit your 5-hour limit · resets {reset}\r")
    s = until(lambda s: s["rateLimit"]["status"] == "waiting", 6)
    rl = s["rateLimit"]
    check("StopFailure hook → waiting on the 5-hour limit", rl["status"] == "waiting" and rl["reason"] == "5-hour limit" and rl["source"] == "hook")
    from datetime import datetime
    when = datetime.fromtimestamp(time.time() + 2 * 3600)
    want = when.replace(second=0, microsecond=0).timestamp()  # local time, as parsed
    got = datetime.fromisoformat(rl["resumeAt"].replace("Z", "+00:00")).timestamp() if rl.get("resumeAt") else 0
    check(f"resume scheduled at reset ({reset}, local time) + 90 s", abs(got - (want + 90)) < 2)
    cpid = rl.get("caffeinatePid")
    check("caffeinate -i running while waiting", bool(cpid) and alive(cpid))
    check("status exit 1 while waiting", run_cli("status")[0] == 1)
    samples = os.path.join(HOME, "logs", "ratelimit-samples.jsonl")
    check("raw limit message saved to ratelimit-samples.jsonl", os.path.exists(samples) and reset in open(samples).read())
    code, _ = run_cli("ctl", "skip-wait", "--yes")
    s = until(lambda s: s["rateLimit"]["status"] == "ok", 10)
    check("skip-wait: continue typed, turn confirmed, resumed", code == 0 and "GOT continue" in t.text() and s["rateLimit"]["status"] == "ok")
    time.sleep(0.5)
    check("caffeinate stopped on resume", cpid and not alive(cpid) and s["rateLimit"]["caffeinatePid"] is None)

    # Still limited after the resume → rescheduled, counted.
    t.type("limited-resumes 1\r")
    t.type(f"limit You've hit your 5-hour limit · resets {reset}\r")
    until(lambda s: s["rateLimit"]["status"] == "waiting", 6)
    run_cli("ctl", "skip-wait", "--yes")
    s = until(lambda s: s["rateLimit"].get("failedResumes") == 1, 8)
    check("still limited after resume → waiting again, 1 failed in a row", s["rateLimit"]["status"] == "waiting" and s["rateLimit"]["failedResumes"] == 1)
    run_cli("ctl", "skip-wait", "--yes")
    s = until(lambda s: s["rateLimit"]["status"] == "ok", 10)
    check("next resume works and resets the count", s["rateLimit"]["status"] == "ok" and s["rateLimit"]["failedResumes"] == 0)

    # Opus cap → /model sonnet (confirmed by PostModelSwitch) → continue at once.
    t.type(f"limit You've hit your Opus limit · resets {reset}\r")
    s = until(lambda s: s["rateLimit"]["status"] == "failover" and s["model"].endswith("sonnet-5-5"), 10)
    check("Opus limit → /model sonnet → continue", "GOT /model sonnet" in t.text() and s["model"] == "claude-sonnet-5-5")
    fo = (s["rateLimit"].get("failovers") or [{}])[-1]
    check("failover recorded (opus→sonnet, back after the Opus reset)", fo.get("from") == "opus" and fo.get("to") == "sonnet" and s["rateLimit"].get("modelRestoreAt"))
    _, logs = run_cli("logs", "--raw", "--event", "model.failover")
    check("model.failover logged", "opus → sonnet" in logs)

    t.type("quit 0\r")
    t.wait_exit()
    shutil.rmtree(proj, ignore_errors=True)


UUID_A = "aaaaaaaa-1111-4111-8111-111111111111"
UUID_B = "bbbbbbbb-2222-4222-8222-222222222222"
UUID_C = "cccccccc-3333-4333-8333-333333333333"


def make_claude_history():
    """Fake ~/.claude: three conversations for CLI_CWD, C is open in a running claude."""
    cc = ENV["CLAUDE_CONFIG_DIR"]
    cwd = os.path.realpath(CLI_CWD)
    proj = os.path.join(cc, "projects", re.sub(r"[^a-zA-Z0-9]", "-", cwd))
    os.makedirs(proj, exist_ok=True)
    os.makedirs(os.path.join(cc, "sessions"), exist_ok=True)

    def user(text):
        return json.dumps({"type": "user", "isSidechain": False, "cwd": cwd, "gitBranch": "main", "message": {"role": "user", "content": text}})

    convs = [
        (UUID_A, [user("Refactor the parser")], 3600),
        (UUID_B, [json.dumps({"type": "mode", "mode": "normal"}), user("<command-name>/model</command-name>"), user("Add retries to the uploader")], 600),
        (UUID_C, [user("Write the release notes")], 5),
    ]
    now = time.time()
    for uid, lines, age in convs:
        f = os.path.join(proj, f"{uid}.jsonl")
        with open(f, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        os.utime(f, (now - age, now - age))
    # This test process stands in for the claude that still has C open.
    with open(os.path.join(cc, "sessions", f"{os.getpid()}.json"), "w") as fh:
        json.dump({"pid": os.getpid(), "sessionId": UUID_C, "cwd": cwd}, fh)


def suite_resume():
    """`csuper resume`: list, pick, refuse an open conversation, --fork, claude args."""
    make_claude_history()
    code, out = run_cli("resume", "--list")
    lines = out.strip().splitlines()
    check("--list: newest first", code == 0 and [l[:8] for l in lines] == ["cccccccc", "bbbbbbbb", "aaaaaaaa"])
    check("--list: first typed prompt, not /model", "Add retries to the uploader" in out)
    check("--list: marks the conversation that's open in claude", "[open, pid" in lines[0])

    code, out = run_cli("resume", "cccc")
    check("resume an open conversation → refused, exit 1", code == 1 and "still open" in out and "--fork" in out)
    code, out = run_cli("resume", "zzzz")
    check("unknown id → exit 2", code == 2)

    t = Dash(cmd=("resume",))
    check("picker opens", t.wait_for("Resume a Claude Code conversation", 6))
    t.show("resume picker")
    check("picker shows prompts and the open marker", "Write the release notes" in t.text() and f"live {os.getpid()}" in t.text())
    t.key(b"\x1b[B", settle=0.4)
    t.key(b"\r")
    check("Enter resumes B under csuper", t.wait_for("READY", 10))
    out = t.text().replace("\n", "")
    check("claude gets --resume <B>", f'"--resume","{UUID_B}"' in out)
    code, st = status_json()
    check("resume = adopt --here: registered, autopilot starts paused (exit 1), adopted from B",
          code == 1 and st and st["autopilot"]["enabled"] is False and st["session"]["adoptedFrom"] == UUID_B)
    t.type("quit 0\r")
    check("exit 0 after claude quits", t.wait_exit() == 0)

    t = Dash(cmd=("resume",))
    t.wait_for("Resume a Claude Code conversation", 6)
    t.key(b"\r")
    check("picking the open conversation is refused", t.wait_exit() == 1 and "still open" in t.text())

    t = Dash(cmd=("resume",))
    t.wait_for("Resume a Claude Code conversation", 6)
    t.key(b"\x1b", settle=0.2)
    check("Esc cancels (exit 130)", t.wait_exit() == 130)

    t = Dash("cccccccc", "--fork", "--", "--model", "opus", cmd=("resume",))
    check("--fork works while it's open", t.wait_for("READY", 10))
    out = t.text().replace("\n", "")
    check("claude gets --resume C --fork-session + passthrough args",
          f'"--resume","{UUID_C}","--fork-session","--settings","<json>","--model","opus"' in out)
    t.type("quit 0\r")
    t.wait_exit()


def ccdir(*p):
    return os.path.join(ENV["CLAUDE_CONFIG_DIR"], *p)


def write_transcript(cwd, uid, prompt, age=60):
    proj = ccdir("projects", re.sub(r"[^a-zA-Z0-9]", "-", cwd))
    os.makedirs(proj, exist_ok=True)
    f = os.path.join(proj, f"{uid}.jsonl")
    with open(f, "w") as fh:
        fh.write(json.dumps({"type": "user", "isSidechain": False, "cwd": cwd, "message": {"role": "user", "content": prompt}}) + "\n")
    t = time.time() - age
    os.utime(f, (t, t))


def registry_entry(pid):
    try:
        with open(ccdir("sessions", f"{pid}.json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def wait(cond, t=8):
    end = time.time() + t
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.1)
    return False


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def csuper_sessions():
    code, out = run_cli("sessions", "--json")
    return json.loads(out) if code == 0 else []


def suite_adopt():
    """`csuper adopt`: refuse live, --stop-original, paused autopilot, dash, re-adopt refused, 3 tabs."""
    p1 = os.path.realpath(os.path.join(HOME, "p1"))
    os.makedirs(p1, exist_ok=True)
    fake = ENV["CSUPER_CLAUDE_BIN"]

    # An ordinary claude (not under csuper) with a conversation open in p1. It runs under
    # a shell, like a real one, so it's reaped when it exits (no zombie to look alive).
    orig = Dash(argv=["/bin/sh", "-c", f"node {fake}; true"], cwd=p1, env={**ENV, "FAKE_CLAUDE_PROMPT": "Fix the flaky upload test"})
    find_orig = lambda: next((e for e in (registry_entry(int(f[:-5])) for f in os.listdir(ccdir("sessions")) if f.endswith(".json")) if e and e.get("cwd") == p1), None)
    check("original claude starts and registers", orig.wait_for("READY", 8) and wait(find_orig))
    entry = find_orig()
    opid, conv = entry["pid"], entry["sessionId"]
    short = conv[:8]

    code, out = run_cli("adopt", short, "--here")
    check("adopting a live conversation without --stop-original is refused (exit 1)",
          code == 1 and f"still open in claude (pid {opid})" in out and "--stop-original" in out)
    code, out = run_cli("adopt", "--all-live", "--dry-run", "--stop-original")
    check("--all-live --dry-run lists it and changes nothing",
          code == 0 and short in out and f"would stop pid {opid}" in out and alive(opid))

    t = Dash(short, "--stop-original", "--here", cmd=("adopt",))
    check("asks y/N listing the pid and project", t.wait_for("[y/N]", 8) and str(opid) in t.text() and "p1" in t.text())
    t.type("y\r")
    ok = check("adopted session starts under csuper", t.wait_for("READY", 15))
    if not ok or VERBOSE:
        print(t.text())
    check("original claude exited and left the registry", not alive(opid) and not registry_entry(opid))
    orig.wait_exit(5)
    out = t.text().replace("\n", "")
    check("claude gets --resume <conversation> and runs in the original folder",
          f'"--resume","{conv}"' in out and f"CWD={p1}" in out and f"CONVERSATION={conv}" in out)
    code, st = status_json()
    check("autopilot starts PAUSED (status exit 1)", code == 1 and st and st["autopilot"]["enabled"] is False)
    check("status shows adopted from", st and st["session"]["adoptedFrom"] == conv)
    sid = st["session"]["id"] if st else ""
    info = json.load(open(os.path.join(HOME, "sessions", f"{sid}.json"))) if sid else {}
    af = info.get("adoptedFrom") or {}
    check("registry adoptedFrom {claudeSessionId, adoptedAt, stoppedPid}",
          af.get("claudeSessionId") == conv and af.get("stoppedPid") == opid and af.get("adoptedAt"))
    check("registry records the conversation the claude has open", info.get("claude_session_id") == conv)

    d = Dash()
    check("dashboard Session panel shows 'adopted from'", d.wait_for(f"adopted from {short}", 8))
    d.show("dash adopted")
    d.quit()

    code, out = run_cli("adopt", short, "--here", "--stop-original")
    check("adopting it again while live is refused: already csuper", code == 1 and "already supervised by csuper" in out)
    check("…and nothing was stopped", alive(st["session"]["claudePid"]) if st else False)

    _, out = run_cli("logs", "--raw", "--session", sid)
    check("session log has adopt.resumed", '"adopt.resumed"' in out)
    with open(os.path.join(HOME, "logs", "adopt.jsonl")) as fh:
        alog = fh.read()
    check("adopt.jsonl has adopt.scan / selected / stop_original / failed",
          all(f'"adopt.{e}"' in alog for e in ("scan", "selected", "stop_original", "failed")))
    t.type("quit 0\r")
    check("session ends cleanly", t.wait_exit() == 0)

    # Picker: multi-select view, Esc cancels.
    t = Dash(cmd=("adopt",))
    check("picker opens across projects with status column", t.wait_for("Adopt Claude Code sessions into csuper", 8) and "ended" in t.text())
    t.show("adopt picker")
    t.key(b" ", settle=0.3)
    check("Space selects", "[x]" in t.text() and "Space select (1)" in t.text())
    t.key(b"\x1b", settle=0.2)
    check("Esc cancels (exit 130)", t.wait_exit() == 130)

    # Three ended conversations at once: --tabs is the default, each gets its own session.
    convs = []
    for i in (2, 3, 4):
        pd = os.path.realpath(os.path.join(HOME, f"p{i}"))
        os.makedirs(pd, exist_ok=True)
        uid = f"{i}{i}{i}{i}{i}{i}{i}{i}-0000-4000-8000-00000000000{i}"
        write_transcript(pd, uid, f"Task number {i}")
        convs.append((uid, pd))
    code, out = run_cli("adopt", *[u for u, _ in convs], "--compact", timeout=40)
    print(out if VERBOSE else "", end="")
    check("3 conversations → exit 0, all adopted in new tabs", code == 0 and out.count("adopted in a new fake-tab.py tab") == 3)
    live = [s for s in csuper_sessions() if s["status"] == "live" and (s.get("adoptedFrom") or {}).get("claudeSessionId") in {u for u, _ in convs}]
    check("`csuper sessions` lists all 3 as live", len(live) == 3)
    check("each has its own socket and log",
          len({s["sock"] for s in live}) == 3 and all(os.path.exists(s["sock"]) and os.path.exists(os.path.join(HOME, "logs", f"{s['id']}.jsonl")) for s in live))
    check("each runs in its own folder", sorted(s["cwd"] for s in live) == sorted(pd for _, pd in convs))
    check("each starts paused", all(run_cli("status", "--session", s["id"])[0] == 1 for s in live))
    check("--compact sends /compact once claude is ready",
          wait(lambda: all('"command.injected"' in open(os.path.join(HOME, "logs", f"{s['id']}.jsonl")).read() for s in live), 10))
    tab_logs = lambda: "".join(open(os.path.join(ENV["FAKE_TAB_DIR"], f)).read() for f in os.listdir(ENV["FAKE_TAB_DIR"]))
    check("…and claude received it", wait(lambda: tab_logs().count('ECHO:"/compact"') == 3, 5))
    for s in live:
        os.kill(s["pid"], signal.SIGTERM)
    check("tab sessions shut down and leave the registry", wait(lambda: not any(os.path.exists(s["sock"]) for s in live), 10))


def suite_real():
    """Opt-in smoke test with the real claude (haiku): adopt --stop-original keeps the conversation."""
    started = []
    try:
        _suite_real(started)
    finally:
        # Hang up any pty still open (SIGHUP), so a failed run leaves no claude behind.
        for d in started:
            try:
                os.close(d.fd)
            except OSError:
                pass
            end = time.time() + 10
            while time.time() < end:
                try:
                    if os.waitpid(d.pid, os.WNOHANG)[0]:
                        break
                except ChildProcessError:
                    break  # already reaped
                time.sleep(0.1)


def _suite_real(started):
    if os.environ.get("CSUPER_E2E_REAL") != "1":
        check("skipped (set CSUPER_E2E_REAL=1 to run; spends a few cents)", True)
        return
    claude = shutil.which("claude")
    if not check("claude on PATH", claude):
        return
    # The real ~/.claude and real claude; csuper state still under the throwaway HOME.
    env = {k: v for k, v in ENV.items() if k not in ("CLAUDE_CONFIG_DIR", "CSUPER_CLAUDE_BIN", "CSUPER_CLAUDE_SCAN", "CSUPER_TAB_LAUNCHER")}
    for k in ("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_ENTRYPOINT",
              "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
              "CLAUDE_CODE_EXECPATH", "AI_AGENT", "CLAUDE_EFFORT"):
        env.pop(k, None)
    # A fixed folder, so repeated runs reuse one ~/.claude/projects entry.
    proj = os.path.realpath("/tmp/csuper-e2e-real")
    os.makedirs(proj, exist_ok=True)
    regdir = os.path.expanduser("~/.claude/sessions")

    def real_reg(pid):
        try:
            with open(os.path.join(regdir, f"{pid}.json")) as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def in_proj():
        for f in os.listdir(regdir):
            e = real_reg(f[:-5]) if f.endswith(".json") else None
            if e and e.get("cwd") == proj and alive(e["pid"]):
                return e
        return None

    if not check("no claude already open in the test folder", not in_proj()):
        return
    # Under a shell, like a real one, so it's reaped when it exits.
    orig = Dash(argv=["/bin/sh", "-c", f"{shlex.quote(claude)} --model haiku; true"], cwd=proj, env=env)
    started.append(orig)
    if orig.wait_for("Yes, I trust this folder", 15):
        # The highlighted default is "No, exit": move down to "Yes, I trust this folder",
        # and only press Enter once the highlight is really on it.
        orig.pump(1.5)
        for _ in range(3):
            orig.key(b"\x1b[B", settle=0.6)
            if "❯ Yes, I trust this folder" in orig.text():
                break
        if not check("trust prompt: 'Yes' highlighted", "❯ Yes, I trust this folder" in orig.text()):
            return
        orig.key(b"\r", settle=2)
    check("real claude registers in ~/.claude/sessions", wait(in_proj, 20))
    entry = in_proj() or {}
    opid, conv = entry.get("pid", 0), entry.get("sessionId", "")
    orig.show("real original")
    orig.type("Reply with just: ok")
    orig.key(b"\r", settle=1)
    transcript = os.path.expanduser(f"~/.claude/projects/{re.sub(r'[^a-zA-Z0-9]', '-', proj)}/{conv}.jsonl")
    check("transcript saving is on (transcript written)", wait(lambda: os.path.exists(transcript), 30))
    wait(lambda: (real_reg(opid) or {}).get("status") == "idle", 60)
    time.sleep(2)

    if not conv:
        return
    t = Dash(conv[:8], "--stop-original", "--here", "--", "--model", "haiku", cmd=("adopt",), env=env)
    started.append(t)
    check("adopt asks y/N", t.wait_for("[y/N]", 15))
    t.type("y\r")
    # Keep reading both terminals, as real ones would: a claude that can't write its
    # exit output to a full pty blocks instead of exiting.
    end = time.time() + 20
    while time.time() < end and (alive(opid) or real_reg(opid)):
        orig.pump(0.1)
        t.pump(0.1)
    check("original exits on SIGTERM and leaves the registry", not alive(opid) and not real_reg(opid))
    orig.wait_exit(5)
    code, st = None, None
    end = time.time() + 30
    while time.time() < end and not st:
        p = subprocess.run([*BIN, "status", "--json"], cwd=CLI_CWD, env=env, capture_output=True, text=True, timeout=20)
        if p.returncode in (0, 1):
            code, st = p.returncode, json.loads(p.stdout)
        else:
            t.pump(0.5)
    t.pump(1)
    check("adopted under csuper, autopilot paused", st and code == 1 and st["session"]["adoptedFrom"] == conv)
    cpid = st["session"]["claudePid"] if st else 0
    check("resumed claude keeps the same conversation ID", wait(lambda: (real_reg(cpid) or {}).get("sessionId") == conv, 30))
    t.show("real adopted")
    os.kill(st["session"]["pid"], signal.SIGTERM) if st else None
    check("session ends on SIGTERM", t.wait_exit(20) is not None)
    print(f"  note: test transcript kept at {transcript}")


SUITES = {
    "keys": suite_keys,
    "reconnect": suite_reconnect,
    "switch": suite_switch,
    "status": suite_status,
    "supervisor": suite_supervisor,
    "autopilot": suite_autopilot,
    "resume": suite_resume,
    "adopt": suite_adopt,
}
# Opt-in suites: only run when named on the command line.
OPT_IN = {"real": suite_real}


def main():
    global current_suite
    if BIN[0] == "node" and not os.path.exists(CLI):
        sys.exit("dist/csuper.js missing — run `npm run build` first")
    wanted = [a for a in sys.argv[1:] if not a.startswith("-")] or list(SUITES)
    if os.environ.get("CSUPER_E2E_REAL") == "1" and "real" not in wanted:
        wanted.append("real")
    SUITES.update(OPT_IN)
    unknown = [w for w in wanted if w not in SUITES]
    if unknown:
        sys.exit(f"unknown suite(s): {', '.join(unknown)}; choose from {', '.join(SUITES)}")
    try:
        for name in wanted:
            current_suite = name
            print(f"\n[{name}] {SUITES[name].__doc__}", flush=True)
            try:
                SUITES[name]()
            except Exception:
                traceback.print_exc()
                check("suite ran to completion", False)
            finally:
                stop_all_demos()
    finally:
        if not os.environ.get("CSUPER_E2E_KEEP"):
            shutil.rmtree(HOME, ignore_errors=True)
        else:
            print(f"kept {HOME}")

    failed = [r for r in results if not r[2]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    for suite, name, _ in failed:
        print(f"  FAIL [{suite}] {name}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
