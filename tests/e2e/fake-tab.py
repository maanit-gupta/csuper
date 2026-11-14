#!/usr/bin/env python3
"""Stand-in for a new terminal tab (CSUPER_TAB_LAUNCHER) in the e2e suite.

Called as `fake-tab.py "<shell command>"`. Detaches, runs the command in its own pty
like a real tab would, and copies everything it prints to $FAKE_TAB_DIR/<pid>.log.
Exits when the command does.
"""
import os
import pty
import sys

cmd = sys.argv[1]
if os.fork():
    sys.exit(0)  # the launcher returns immediately, like osascript does
os.setsid()
log_dir = os.environ.get("FAKE_TAB_DIR", "/tmp")
os.makedirs(log_dir, exist_ok=True)
pid, fd = pty.fork()
if pid == 0:
    os.execvp("/bin/sh", ["/bin/sh", "-c", cmd])
with open(os.path.join(log_dir, f"{pid}.log"), "ab", buffering=0) as log:
    log.write(f"$ {cmd}\n".encode())
    while True:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        log.write(data)
os.waitpid(pid, 0)
