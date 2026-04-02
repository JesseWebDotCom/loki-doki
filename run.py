#!/usr/bin/env python3
"""Single Phase 1 entry point for LokiDoki."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from app.config import (
    DATA_DIR,
    PUBLIC_HOST,
    PUBLIC_PORT,
    ROOT_DIR,
    UI_DIST_DIR,
    detect_profile,
)

LOGGER = logging.getLogger("lokidoki.run")
STATUS_URL = f"http://{PUBLIC_HOST}:{PUBLIC_PORT}/api/bootstrap/status"
REINSTALL_URL = f"http://{PUBLIC_HOST}:{PUBLIC_PORT}/api/install/reinstall"
APP_URL = f"http://{PUBLIC_HOST}:{PUBLIC_PORT}/"
SETUP_URL = f"http://{PUBLIC_HOST}:{PUBLIC_PORT}/setup"
BOOTSTRAP_SIGNATURE_PATH = DATA_DIR / "bootstrap_server.sig"


def request_json(url: str, method: str = "GET", body: bytes | None = None) -> dict:
    """Perform a JSON request against the local bootstrap server."""
    request = urllib.request.Request(
        url,
        method=method,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=2.0) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_server(url: str, timeout: float = 30.0) -> dict:
    """Wait for the bootstrap server to become reachable."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return request_json(url)
        except Exception:
            time.sleep(0.25)
    raise RuntimeError(f"Bootstrap server did not start within {timeout:.0f}s.")


def get_running_status() -> dict | None:
    """Return the current bootstrap status if the server is already running."""
    try:
        return request_json(STATUS_URL)
    except Exception:
        return None


def current_bootstrap_signature() -> str:
    """Return a coarse signature of bootstrap-relevant code and built UI assets."""
    hasher = hashlib.sha256()
    for base_path in _signature_paths():
        if not base_path.exists():
            continue
        process_paths = [base_path] + list(base_path.rglob("*")) if base_path.is_dir() else [base_path]
        for path in sorted(process_paths):
            if path.is_dir():
                continue
            stat = path.stat()
            hasher.update(str(path.relative_to(ROOT_DIR)).encode("utf-8"))
            hasher.update(str(stat.st_mtime_ns).encode("utf-8"))
            hasher.update(str(stat.st_size).encode("utf-8"))
    return hasher.hexdigest()


def _signature_paths() -> list[Path]:
    """Return files that should force bootstrap refresh when they change."""
    paths = [
        ROOT_DIR / "run.py",
        ROOT_DIR / "app" / "main.py",
        ROOT_DIR / "app" / "api",
        ROOT_DIR / "app" / "bootstrap",
        ROOT_DIR / "app" / "config.py",
        ROOT_DIR / "app" / "skills",
        ROOT_DIR / "app" / "ui" / "src",
        Path(os.environ.get("LOKIDOKI_DATA_DIR", str(ROOT_DIR / ".lokidoki"))) / "skills",
    ]
    if UI_DIST_DIR.exists():
        paths.extend(sorted(path for path in UI_DIST_DIR.rglob("*") if path.is_file()))
    return paths


def stored_bootstrap_signature() -> str:
    """Return the signature of the last launched bootstrap server."""
    if not BOOTSTRAP_SIGNATURE_PATH.exists():
        return ""
    return BOOTSTRAP_SIGNATURE_PATH.read_text(encoding="utf-8").strip()


def save_bootstrap_signature(signature: str) -> None:
    """Persist the signature of the launched bootstrap server."""
    BOOTSTRAP_SIGNATURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BOOTSTRAP_SIGNATURE_PATH.write_text(signature, encoding="utf-8")


def bootstrap_server_is_stale() -> bool:
    """Return whether the running bootstrap server should be restarted."""
    stored = stored_bootstrap_signature()
    if not stored:
        return True
    return stored != current_bootstrap_signature()


def port_is_busy() -> bool:
    """Return whether the public bootstrap port is already bound locally."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((PUBLIC_HOST, PUBLIC_PORT))
        except OSError:
            return True
        return False


def wait_for_existing_server(timeout: float = 10.0) -> dict | None:
    """Wait briefly for an already-bound bootstrap port to become responsive."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = get_running_status()
        if status:
            return status
        if not port_is_busy():
            return None
        time.sleep(0.25)
    return None


def wait_for_port_release(timeout: float = 3.0) -> bool:
    """Wait for the bootstrap port to become free after a shutdown."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not port_is_busy():
            return True
        time.sleep(0.25)
    return False


def bootstrap_server_pids() -> list[int]:
    """Return PIDs for active LokiDoki bootstrap server processes."""
    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    pids: list[int] = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if "app.bootstrap.server" not in stripped:
            continue
        pid_text, _, _command = stripped.partition(" ")
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid != os.getpid():
            pids.append(pid)
    return pids


def terminate_bootstrap_servers() -> bool:
    """Terminate stale bootstrap server processes and wait for the port to free."""
    pids = bootstrap_server_pids()
    if not pids:
        return False
    LOGGER.warning(
        "Stopping unresponsive bootstrap server process(es): %s",
        ", ".join(str(pid) for pid in pids),
    )
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            continue
    if wait_for_port_release(timeout=1.5):
        return True
    LOGGER.warning("Bootstrap server did not exit after SIGTERM. Forcing shutdown.")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            continue
    return wait_for_port_release(timeout=1.5)


def active_bootstrap_process_exists() -> bool:
    """Return whether a LokiDoki bootstrap server process already exists."""
    return bool(bootstrap_server_pids())


def warn_if_text_provider_unavailable(profile: str) -> None:
    """Log a startup warning when the CPU text provider is unavailable."""
    if profile not in {"mac", "pi_cpu"}:
        return

    try:
        from app.providers.ollama import probe_provider_endpoint
        from app.providers.ollama_service import OLLAMA_ENDPOINT
        from app.providers.types import ProviderSpec
    except ImportError:
        return
    probe = probe_provider_endpoint(
        ProviderSpec(
            name="llm_fast",
            backend="ollama",
            model="startup-check",
            acceleration="cpu",
            endpoint=OLLAMA_ENDPOINT,
        ),
        timeout=0.5,
    )
    if not probe["ok"]:
        LOGGER.warning(
            "Ollama is not reachable on %s. LokiDoki will show the installer and repair text-model setup there once the bootstrap UI is open.",
            profile,
        )


def build_command(profile: str, reinstall: bool) -> list[str]:
    """Build the bootstrap subprocess command."""
    python_binary = cli_python_executable()
    command = [
        python_binary,
        "-m",
        "app.bootstrap.server",
        "--profile",
        profile,
    ]
    if reinstall:
        command.append("--reinstall")
    return command


def cli_python_executable() -> str:
    """Return a plain CLI Python binary for child processes when available."""
    return sys.executable


def status_can_launch(status: dict) -> bool:
    """Return whether bootstrap status represents a launchable app."""
    if "can_launch" in status:
        return bool(status.get("can_launch"))
    return bool(
        status.get("ready")
        and not status.get("setup_required")
        and status.get("app_running")
    )


def open_browser(status: dict, reinstall: bool, no_browser: bool) -> None:
    """Open the correct browser target for the current installer state."""
    target = APP_URL
    if reinstall or status.get("setup_required") or not status_can_launch(status):
        target = SETUP_URL
    if no_browser:
        LOGGER.info("Browser launch skipped. Open %s", target)
        return
    webbrowser.open(target)
    LOGGER.info("Opened %s", target)


def log_ready_status(status: dict) -> None:
    """Log a friendly summary once the bootstrap server is ready."""
    target = (
        APP_URL
        if status_can_launch(status)
        else SETUP_URL
    )
    LOGGER.info("LokiDoki is running at %s", target)
    if not status_can_launch(status) and status.get("blocking_issues"):
        LOGGER.warning(
            "Bootstrap still has blocking issues: %s",
            "; ".join(str(issue) for issue in status["blocking_issues"]),
        )
    LOGGER.info(
        "This terminal stays attached while the app is running. Press Ctrl+C to stop it."
    )


def reuse_existing_server(args: argparse.Namespace) -> bool:
    """Reuse an already-running bootstrap server instead of spawning a duplicate."""
    status = get_running_status()
    if not status and port_is_busy():
        if active_bootstrap_process_exists():
            status = wait_for_existing_server(timeout=2.0)
        else:
            status = wait_for_existing_server(timeout=0.5)
    if not status:
        if port_is_busy():
            if terminate_bootstrap_servers():
                LOGGER.info(
                    "Removed stale bootstrap server. Starting a fresh instance."
                )
                return False
            if wait_for_port_release():
                return False
            raise RuntimeError(
                f"Port {PUBLIC_PORT} is already in use, but no LokiDoki bootstrap server responded on {STATUS_URL}."
            )
        return False
    if bootstrap_server_is_stale():
        LOGGER.info("Bootstrap server is running older code. Restarting it.")
        if terminate_bootstrap_servers():
            return False
        raise RuntimeError("Could not restart the stale LokiDoki bootstrap server.")
    LOGGER.info(
        "Bootstrap server already running on http://%s:%s", PUBLIC_HOST, PUBLIC_PORT
    )
    if args.reinstall:
        LOGGER.info("Triggering reinstall on the existing bootstrap server.")
        status = request_json(REINSTALL_URL, method="POST", body=b"{}")
    open_browser(status, args.reinstall, args.no_browser)
    return True


def main() -> None:
    """Launch the stdlib bootstrap server and optionally open the browser."""
    parser = argparse.ArgumentParser(description="Run LokiDoki Phase 1.")
    parser.add_argument(
        "--reinstall", action="store_true", help="Force the installer flow."
    )
    parser.add_argument(
        "--no-browser", action="store_true", help="Skip opening the browser."
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    profile = detect_profile()
    LOGGER.info("Detected profile: %s", profile)

    if reuse_existing_server(args):
        return

    save_bootstrap_signature(current_bootstrap_signature())

    # Start server first to minimize wait time for the UI
    process = subprocess.Popen(
        build_command(profile, args.reinstall), start_new_session=True
    )

    try:
        status = wait_for_server(STATUS_URL)
        warn_if_text_provider_unavailable(profile)
        log_ready_status(status)
        open_browser(status, args.reinstall, args.no_browser)
        process.wait()
    except KeyboardInterrupt:
        LOGGER.info("Stopping LokiDoki bootstrap server.")
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
    except Exception:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        raise


if __name__ == "__main__":
    main()
