
from __future__ import annotations
import os
def force_installer_enabled() -> bool:
    return os.environ.get("FORCE_INSTALLER") == "1"
"""Stdlib bootstrap server for Phase 1."""

import argparse
import errno
import http.client
import json
import logging
import signal
import socket
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from app.bootstrap.health import evaluate_health
from app.bootstrap.installer import InstallerManager
from app.config import PUBLIC_HOST, PUBLIC_PORT, default_public_bind_host


LOGGER = logging.getLogger(__name__)
ROOT_DIR = Path(__file__).resolve().parents[2]
STATIC_DIR = ROOT_DIR / "app" / "bootstrap" / "static"
ROOT_STATIC_FILES = {
    "/favicon.ico": STATIC_DIR / "favicon.ico",
    "/favicon-16x16.png": STATIC_DIR / "favicon-16x16.png",
    "/favicon-32x32.png": STATIC_DIR / "favicon-32x32.png",
    "/apple-touch-icon.png": STATIC_DIR / "apple-touch-icon.png",
    "/android-chrome-192x192.png": STATIC_DIR / "android-chrome-192x192.png",
    "/android-chrome-512x512.png": STATIC_DIR / "android-chrome-512x512.png",
    "/site.webmanifest": STATIC_DIR / "site.webmanifest",
}
MANAGER: InstallerManager


def proxy_timeout_for_path(path: str) -> float:
    """Return a proxy timeout tuned for the current endpoint."""
    if (
        path.startswith("/api/image/")
        or path.startswith("/api/video/")
        or path.startswith("/api/document/")
    ):
        return 180.0
    if (
        path.startswith("/api/settings/character")
        or path.startswith("/api/admin/prompt-lab")
    ):
        return 120.0
    if path.startswith("/api/voices/speak") or path.startswith("/api/voice/chat"):
        return 90.0
    if path.startswith("/api/chat/stream"):
        return 120.0
    return 30.0


class BootstrapHTTPServer(ThreadingHTTPServer):
    """HTTP server with safe local restart behavior."""

    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False


class BootstrapHandler(BaseHTTPRequestHandler):
    """Serve the installer and proxy the main app."""

    server_version = "LokiDoki Installer/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ROOT_STATIC_FILES:
            return self._serve_file(
                ROOT_STATIC_FILES[parsed.path], self._guess_content_type(parsed.path)
            )
        if parsed.path == "/api/bootstrap/status":
            return self._json(MANAGER.get_status())
        if parsed.path == "/api/bootstrap/health":
            return self._json(evaluate_health(MANAGER))
        if parsed.path == "/install/stream":
            return self._stream_events()
        if parsed.path == "/setup":
            return self._serve_file(
                STATIC_DIR / "index.html", "text/html; charset=utf-8"
            )
        if parsed.path.startswith("/setup/"):
            asset_name = parsed.path.removeprefix("/setup/")
            return self._serve_file(
                STATIC_DIR / asset_name, self._guess_content_type(asset_name)
            )
        # Force installer if env var is set
        if force_installer_enabled() and parsed.path == "/":
            return self._redirect("/setup")
        if parsed.path == "/" and not MANAGER.get_status()["ready"]:
            return self._redirect("/setup")
        return self._proxy_to_app()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/install/start":
            return self._json(MANAGER.start_install())
        if parsed.path == "/api/install/reinstall":
            return self._json(MANAGER.restart_install())
        if parsed.path == "/api/setup/submit":
            payload = self._read_json()
            result = MANAGER.submit_setup(payload)
            code = 200 if result.get("ok") else 400
            return self._json(result, status=code)
        return self._proxy_to_app()

    def do_PUT(self) -> None:
        self._proxy_to_app()

    def do_PATCH(self) -> None:
        self._proxy_to_app()

    def do_DELETE(self) -> None:
        self._proxy_to_app()

    def _stream_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last_id = int(self.headers.get("Last-Event-ID", "0") or "0")
        for event in MANAGER.stream(last_id):
            payload = json.dumps(
                {
                    "step": event["step"],
                    "status": event["status"],
                    "pct": event["pct"],
                    "log": event["log"],
                }
            )
            chunk = f"id: {event['id']}\ndata: {payload}\n\n".encode("utf-8")
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
            except BrokenPipeError:
                return

    def _proxy_to_app(self) -> None:
        if not MANAGER.is_app_reachable():
            return self._redirect("/setup")
        body = None
        if self.command in {"POST", "PUT", "PATCH"}:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else None
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in {"host", "connection", "content-length"}
        }
        request = urllib.request.Request(
            f"{MANAGER.internal_app_url}{self.path}",
            data=body,
            method=self.command,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(
                request, timeout=proxy_timeout_for_path(self.path)
            ) as response:
                self.send_response(response.status)
                content_type = ""
                for key, value in response.getheaders():
                    if key.lower() == "content-type":
                        content_type = value
                    if key.lower() not in {
                        "transfer-encoding",
                        "connection",
                        "server",
                        "date",
                    }:
                        self.send_header(key, value)
                self.end_headers()
                
                # Stream the response back in chunks
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    # Flush for event streams to ensure real-time delivery
                    if "text/event-stream" in content_type:
                        self.wfile.flush()
        except urllib.error.HTTPError as exc:
            self.send_response(exc.code)
            for key, value in exc.headers.items():
                if key.lower() not in {
                    "transfer-encoding",
                    "connection",
                    "server",
                    "date",
                }:
                    self.send_header(key, value)
            self.end_headers()
            self.wfile.write(exc.read())
        except (
            TimeoutError,
            socket.timeout,
            urllib.error.URLError,
            http.client.RemoteDisconnected,
        ) as exc:
            detail = f"Upstream app request failed for {self.path}: {exc}"
            LOGGER.warning(detail)
            if self.path.startswith("/api/"):
                return self._json({"detail": detail}, status=504)
            self.send_error(504, detail)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _serve_file(self, path: Path, content_type: str) -> None:
        if not path.exists():
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if self.path == "/setup" or self.path.startswith("/setup/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
        self.end_headers()
        self.wfile.write(path.read_bytes())

    def _json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.end_headers()

    def _guess_content_type(self, name: str) -> str:
        if name.endswith(".css"):
            return "text/css; charset=utf-8"
        if name.endswith(".js"):
            return "application/javascript; charset=utf-8"
        if name.endswith(".svg"):
            return "image/svg+xml"
        if name.endswith(".png"):
            return "image/png"
        if name.endswith(".ico"):
            return "image/x-icon"
        if name.endswith(".webmanifest"):
            return "application/manifest+json; charset=utf-8"
        return "application/octet-stream"

    def log_message(self, fmt: str, *args: object) -> None:
        message = fmt % args
        if (
            '"POST /api/wakeword/detect HTTP/1.1"' in message
            or '"GET /api/health HTTP/1.1"' in message
        ):
            LOGGER.debug("%s - %s", self.address_string(), message)
            return
        LOGGER.info("%s - %s", self.address_string(), message)

    def handle(self) -> None:
        """Ignore common local disconnect noise from browsers/EventSource clients."""
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, socket.timeout) as exc:
            if (
                isinstance(exc, ConnectionResetError)
                and getattr(exc, "errno", None) != errno.ECONNRESET
            ):
                raise
            LOGGER.debug("Client disconnected during request handling: %s", exc)


def main() -> None:
    """Start the bootstrap server."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--reinstall", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    global MANAGER
    MANAGER = InstallerManager(
        ROOT_DIR, profile=args.profile, force_reinstall=args.reinstall
    )
    bind_host = default_public_bind_host(args.profile)
    server = BootstrapHTTPServer((bind_host, PUBLIC_PORT), BootstrapHandler)
    server.timeout = 0.5

    def shutdown_handler(*_: object) -> None:
        LOGGER.info("Shutting down bootstrap server.")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)
    LOGGER.info("Bootstrap server listening on http://%s:%s", bind_host, PUBLIC_PORT)
    MANAGER.autostart()
    try:
        server.serve_forever()
    finally:
        MANAGER.stop_app()
        server.server_close()


if __name__ == "__main__":
    main()
