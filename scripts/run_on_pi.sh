#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_pi_common.sh"

COMMAND="${1:-status}"
shift || true

require_pi_host

remote_bootstrap_reinstall_python() {
  cat <<'PY'
import json
import urllib.request

request = urllib.request.Request(
    "http://127.0.0.1:7860/api/install/reinstall",
    method="POST",
    data=b"{}",
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=10) as response:
    print(response.read().decode("utf-8"))
PY
}

remote_status_python() {
  cat <<'PY'
import json
import urllib.request

for path in ("/api/bootstrap/status", "/api/bootstrap/health", "/api/providers", "/api/hailo/status"):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:7860{path}", timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
            print(f"{path}: {json.dumps(payload)}")
    except Exception as exc:
        print(f"{path}: ERROR {exc}")
PY
}

remote_wait_for_bootstrap_python() {
  cat <<'PY'
import time
import urllib.request

deadline = time.time() + 30
last_error = "bootstrap did not respond"
while time.time() < deadline:
    try:
        with urllib.request.urlopen("http://127.0.0.1:7860/api/bootstrap/status", timeout=2) as response:
            print(response.read().decode("utf-8"))
            raise SystemExit(0)
    except Exception as exc:
        last_error = str(exc)
        time.sleep(0.5)
print(last_error)
raise SystemExit(1)
PY
}

case "$COMMAND" in
  start)
    run_ssh "mkdir -p \"$PI_REMOTE_DIR/.lokidoki\"; cd \"$PI_REMOTE_DIR\"; nohup python3 run.py --no-browser > \"$(remote_log_file)\" 2>&1 & pid=\$!; echo \$pid > \"$(remote_pid_file)\""
    if run_ssh "python3 - <<'PY'
$(remote_wait_for_bootstrap_python)
PY" >/dev/null; then
      echo "Pi app start requested."
    else
      echo "Pi app failed to start cleanly. Recent log output:" >&2
      "$SCRIPT_DIR/pi_log.sh"
      exit 1
    fi
    ;;
  reinstall)
    if ./scripts/run_on_pi.sh status >/dev/null 2>&1; then
      run_ssh "python3 - <<'PY'
$(remote_bootstrap_reinstall_python)
PY"
    else
      run_ssh "mkdir -p \"$PI_REMOTE_DIR/.lokidoki\"; cd \"$PI_REMOTE_DIR\"; nohup python3 run.py --no-browser --reinstall > \"$(remote_log_file)\" 2>&1 & pid=\$!; echo \$pid > \"$(remote_pid_file)\""
    fi
    echo "Pi reinstall start requested."
    ;;
  stop)
    run_ssh "python3 - <<'PY'
import os
import pathlib
import signal
import time
import subprocess

pid_file = pathlib.Path('$(remote_pid_file)')
if pid_file.exists():
    try:
        os.kill(int(pid_file.read_text().strip()), signal.SIGTERM)
    except Exception:
        pass
    pid_file.unlink(missing_ok=True)

patterns = [
    'python3 run.py --no-browser',
    'app.bootstrap.server',
    'uvicorn app.main:app',
]
output = subprocess.run(
    ['ps', '-eo', 'pid=,args='],
    check=False,
    capture_output=True,
    text=True,
).stdout.splitlines()
for raw in output:
    raw = raw.strip()
    if not raw:
        continue
    pid_text, _, cmd = raw.partition(' ')
    try:
        pid = int(pid_text)
    except ValueError:
        continue
    if pid in {os.getpid(), os.getppid()}:
        continue
    if any(pattern in cmd for pattern in patterns):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
time.sleep(1.0)
for raw in output:
    raw = raw.strip()
    if not raw:
        continue
    pid_text, _, cmd = raw.partition(' ')
    try:
        pid = int(pid_text)
    except ValueError:
        continue
    if pid in {os.getpid(), os.getppid()}:
        continue
    if any(pattern in cmd for pattern in patterns):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
PY"
    echo "Pi app stop requested."
    ;;
  restart)
    "$SCRIPT_DIR/run_on_pi.sh" stop
    sleep 1
    "$SCRIPT_DIR/run_on_pi.sh" start
    ;;
  status)
    run_ssh "set -e; echo \"host=\$(hostname)\"; echo \"uptime=\$(uptime | sed 's/^ *//')\"; pid=\$(pgrep -fo 'app.bootstrap.server' || true); echo \"pid=\$pid\"; python3 - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1)
busy = s.connect_ex(('127.0.0.1', 7860)) == 0
s.close()
print(f'bootstrap_port_open={busy}')
PY"
    ;;
  validate)
    run_ssh "cd \"$PI_REMOTE_DIR\" && echo \"repo=\$(pwd)\" && python3 - <<'PY'
$(remote_status_python)
PY"
    ;;
  doctor)
    run_ssh "echo \"host=\$(hostname)\"; echo \"kernel=\$(uname -a)\"; echo \"python=\$(command -v python3 || true)\"; echo \"npm=\$(command -v npm || true)\"; echo \"ollama=\$(command -v ollama || true)\"; echo \"hailortcli=\$(command -v hailortcli || true)\"; echo \"hailo_device=\$(ls /dev/hailo0 2>/dev/null || true)\"; echo \"legacy_blacklist=\$(ls /etc/modprobe.d/blacklist-hailo-legacy.conf 2>/dev/null || true)\""
    ;;
  shell)
    run_ssh "cd \"$PI_REMOTE_DIR\" && ${*:-bash -l}"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|reinstall|status|validate|doctor|shell [cmd...]}" >&2
    exit 1
    ;;
esac
