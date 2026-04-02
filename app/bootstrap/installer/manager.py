"""Installer manager for the stdlib bootstrap server."""

from __future__ import annotations

import os
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Iterator, Optional

from app import db
from app.config import (
    PUBLIC_HOST,
    PUBLIC_PORT,
    get_profile_defaults,
    load_bootstrap_config,
)
from app.providers.ollama_service import ensure_ollama_models, ensure_ollama_service
from . import utils, models, backend_manager, platform_manager, frontend_manager


LOGGER = logging.getLogger(__name__)
APP_START_TIMEOUT_SECONDS = 20.0


class InstallerManager:
    """Coordinate bootstrap install steps and app lifecycle."""

    def __init__(self, root_dir: Path, profile: str, force_reinstall: bool = False):
        self.root_dir = root_dir
        self.profile = profile
        self.data_dir = root_dir / ".lokidoki"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.runtime_dir = self.data_dir / "app-venv"
        self.runtime_python = self.runtime_dir / "bin" / "python"
        self.bootstrap_config_path = self.data_dir / "bootstrap_config.json"
        
        self.requirements_path = root_dir / "requirements-app.txt"
        self.ui_dir = root_dir / "app" / "ui"
        self.ui_dist_dir = self.ui_dir / "dist"
        
        self.state_path = self.data_dir / "installer_state.json"
        self.log_path = self.data_dir / "installer.log"
        self.app_log_path = self.data_dir / "app.log"
        
        self._lock = threading.RLock()
        self._event = threading.Condition(self._lock)
        self._install_thread: Optional[threading.Thread] = None
        self._events: list[dict[str, Any]] = []
        self._event_id = 0
        
        self._app_process: Optional[Any] = None
        self._state = models.default_state(
            profile,
            get_profile_defaults(profile),
            self.bootstrap_config_path.exists()
        )
        self._load_state()

    def _load_state(self) -> None:
        """Load the persisted installer state."""
        if self.state_path.exists():
            try:
                loaded = json.loads(self.state_path.read_text(encoding="utf-8"))
                self._state.update({k: v for k, v in loaded.items() if k in self._state})
            except (json.JSONDecodeError, Exception):
                pass
        self.log_path.touch(exist_ok=True)
        self.app_log_path.touch(exist_ok=True)

    def _save_state(self) -> None:
        """Persist current state to file."""
        with self._lock:
            self.state_path.write_text(json.dumps(self._state, indent=2), encoding="utf-8")

    def _load_runtime_config(self) -> tuple[str, dict[str, str]]:
        """Return the active profile and merged model configuration."""
        config = load_bootstrap_config(self.bootstrap_config_path)
        profile = str(config.get("profile") or self.profile)
        models_map = config.get("models")
        if isinstance(models_map, dict):
            models = {key: str(value) for key, value in models_map.items()}
        else:
            models = get_profile_defaults(profile)
        return profile, models

    def _blocking_issues_for(self, app_running: bool) -> list[str]:
        """Return issues that should block app launch."""
        issues: list[str] = []
        if not self.bootstrap_config_path.exists() or self._state.get("setup_required"):
            return issues
        if not app_running:
            issues.append("FastAPI app is not running yet.")
        profile, selected_models = self._load_runtime_config()
        issues.extend(platform_manager.critical_runtime_issues(profile, selected_models))
        return issues

    def _refresh_readiness_locked(self) -> None:
        """Refresh readiness flags from live runtime state."""
        app_running = self.is_app_reachable()
        blocking_issues = self._blocking_issues_for(app_running)
        can_launch = bool(
            app_running
            and not blocking_issues
            and not self._state.get("setup_required")
        )
        self._state["app_running"] = app_running
        self._state["blocking_issues"] = blocking_issues
        self._state["can_launch"] = can_launch
        self._state["ready"] = can_launch
        if self._state.get("status") == "ready" and not can_launch:
            self._state["status"] = "failed" if self._state.get("error") else "idle"

    def _reset_pipeline_state_locked(self) -> None:
        """Reset progress steps before a fresh install run."""
        self._state["steps"] = models.default_steps()
        self._state["current_step"] = "profile"
        self._state["current_action"] = "Preparing installation..."
        self._state["ready"] = False
        self._state["can_launch"] = False
        self._state["blocking_issues"] = []
        self._state["error"] = None
        if not self._state.get("setup_required"):
            for step in self._state["steps"]:
                if step["id"] == "setup":
                    step["status"] = "done"
                    break

    def _publish(self, step: str, status: str, pct: int, log: str) -> None:
        """Publish a new progress event to listeners."""
        with self._lock:
            self._event_id += 1
            event = {"id": self._event_id, "step": step, "status": status, "pct": pct, "log": log}
            self._events.append(event)
            self._events = self._events[-200:]
            
            # Sync persistent state for UI
            self._state["current_step"] = step
            self._state["current_action"] = log
            for s in self._state["steps"]:
                if s["id"] == step:
                    s["status"] = status
                    s["pct"] = pct
                    break
            self._refresh_readiness_locked()
            self._save_state()
            self._event.notify_all()

    def get_status(self) -> dict[str, Any]:
        """Return the current installer state."""
        with self._lock:
            self._refresh_readiness_locked()
            self._state["log_tail"] = self.read_logs()
            self._save_state()
            return self._state.copy()

    def _image_models_cached(self) -> bool:
        """Return True if common image model weights are detected on disk."""
        # Check standard HuggingFace cache locations for SD 1.5
        cache_path = Path.home() / ".cache" / "huggingface" / "hub"
        if not cache_path.exists():
            return False
        # Look for runwayml/stable-diffusion-v1-5 or similar patterns
        for item in cache_path.iterdir():
            if "stable-diffusion" in item.name.lower():
                return True
        return False

    def read_logs(self) -> list[str]:
        """Return the last few lines of the logs."""
        lines = []
        if self.log_path.exists():
            lines.extend(self.log_path.read_text(errors="ignore").splitlines())
        return lines[-100:]

    def submit_setup(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Save initial configuration and seed database."""
        app_name = str(payload.get("app_name") or "LokiDoki").strip()
        
        # Priority: Environment Variables -> Payload UI -> Defaults
        username = os.environ.get("LOKIDOKI_ADMIN_USERNAME") or str(payload.get("admin_username") or "admin").strip()
        password = os.environ.get("LOKIDOKI_ADMIN_PASSWORD") or str(payload.get("admin_password") or "").strip()
        
        if len(password) < 8:
            return {"ok": False, "error": "Password must be at least 8 characters."}
            
        config = {
            "app_name": app_name,
            "profile": self.profile,
            "admin": {"username": username, "password_hash": utils.hash_password(password)},
            "models": get_profile_defaults(self.profile)
        }
        self.bootstrap_config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
        
        # Seed DB
        conn = db.connect(self.data_dir / "lokidoki.db")
        db.initialize_database(conn)
        db.ensure_admin_user(conn, username, config["admin"]["password_hash"], display_name=app_name)
        conn.close()
        
        self._state["setup_required"] = False
        self._publish("setup", "done", 90, f"Saved setup for profile '{self.profile}'.")
        return {"ok": True}

    def start_install(self) -> dict[str, Any]:
        """Start the background pipeline."""
        with self._lock:
            if self._install_thread and self._install_thread.is_alive():
                return self.get_status()
            self._refresh_readiness_locked()
            if self._state.get("can_launch"):
                self._state["status"] = "ready"
                return self.get_status()
            self._reset_pipeline_state_locked()
            self._state["status"] = "running"
            self._save_state()
            self._install_thread = threading.Thread(target=self._run_pipeline, daemon=True)
            self._install_thread.start()
        return self.get_status()

    def _run_pipeline(self) -> None:
        """Execute the full installation sequence."""
        try:
            if self.is_app_reachable() and self.ui_dist_dir.exists():
                with self._lock:
                    self._refresh_readiness_locked()
                    if self._state["can_launch"]:
                        self._state["status"] = "ready"
                self._publish("app", "done", 100, "LokiDoki is ready.")
                return

            self._publish("runtime", "running", 10, "Ensuring Python runtime...")
            backend_manager.ensure_runtime(self.runtime_dir, self.runtime_python)
            self._publish("runtime", "done", 10, "Runtime ready.")

            self._publish("backend", "running", 20, "Installing backend dependencies...")
            backend_manager.install_backend(self.runtime_python, self.requirements_path, self.log_path)
            self._publish("backend", "done", 20, "Backend dependencies installed.")

            self._repair_platform_runtime()

            self._publish("frontend", "running", 90, "Installing frontend dependencies...")
            frontend_manager.install_frontend(self.ui_dir, self.log_path)
            self._publish("frontend", "done", 90, "Assets ready.")

            self._publish("build", "running", 95, "Building distribution bundle...")
            frontend_manager.build_frontend(self.ui_dir, self.log_path)
            self._publish("build", "done", 95, "Compilation complete.")

            self._publish("app", "running", 99, "Starting main application...")
            self._app_process = backend_manager.start_app(
                self.runtime_python,
                self.root_dir,
                self.app_log_path,
            )
            self._wait_for_app_start()
            with self._lock:
                self._state["status"] = "ready"
                self._state["error"] = None
                self._refresh_readiness_locked()
                if not self._state["can_launch"]:
                    raise RuntimeError(self._format_blocking_issues())
            self._publish("app", "done", 100, "LokiDoki is ready.")
        except Exception as exc:
            with self._lock:
                self._state["status"] = "failed"
                self._state["ready"] = False
                self._state["can_launch"] = False
                self._state["error"] = str(exc)
            self._publish("app", "failed", 0, f"Error: {exc}")

    def _repair_platform_runtime(self) -> None:
        """Repair platform runtime dependencies that block readiness."""
        if not self.bootstrap_config_path.exists():
            return

        profile, selected_models = self._load_runtime_config()
        llm_models = [
            selected_models.get("llm_fast", ""),
            selected_models.get("llm_thinking", ""),
            selected_models.get("function_model", ""),
        ]
        vision_model = selected_models.get("vision_model", "")

        self._publish("platform_llm", "running", 55, "Repairing local LLM runtime...")
        if profile in {"mac", "pi_cpu"}:
            service_result = ensure_ollama_service(
                profile,
                LOGGER,
                timeout=12.0,
                log_path=self.log_path,
            )
            if not service_result["ok"]:
                raise RuntimeError(str(service_result["detail"]))
            model_result = ensure_ollama_models(
                llm_models,
                LOGGER,
                timeout=12.0,
                log_path=self.log_path,
            )
            if not model_result["ok"]:
                raise RuntimeError(str(model_result["detail"]))
        issues = platform_manager.critical_runtime_issues(profile, selected_models)
        if issues:
            raise RuntimeError("; ".join(dict.fromkeys(issues)))
        self._publish("platform_llm", "done", 55, "LLM runtime ready.")

        self._publish("platform_vision", "running", 70, "Checking vision runtime...")
        if profile in {"mac", "pi_cpu"} and vision_model:
            vision_result = ensure_ollama_models(
                [vision_model],
                LOGGER,
                timeout=12.0,
                log_path=self.log_path,
            )
            if not vision_result["ok"]:
                raise RuntimeError(str(vision_result["detail"]))
        issues = platform_manager.critical_runtime_issues(profile, selected_models)
        if issues:
            raise RuntimeError("; ".join(dict.fromkeys(issues)))
        self._publish("platform_vision", "done", 70, "Vision runtime ready.")

    def _wait_for_app_start(self, timeout: float = APP_START_TIMEOUT_SECONDS) -> None:
        """Wait for the FastAPI app to respond after spawning it."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.is_app_reachable():
                return
            if self._app_process is not None and self._app_process.poll() is not None:
                break
            time.sleep(0.25)
        detail = self._app_failure_detail()
        raise RuntimeError(f"Main app failed to start. {detail}")

    def _app_failure_detail(self) -> str:
        """Return a concise startup failure message from the app log."""
        if not self.app_log_path.exists():
            return "Check the bootstrap logs for details."
        lines = [
            line.strip()
            for line in self.app_log_path.read_text(encoding="utf-8", errors="ignore").splitlines()
            if line.strip()
        ]
        if not lines:
            return f"See {self.app_log_path} for details."
        tail = " | ".join(lines[-5:])
        return f"Recent app log: {tail}"

    def _format_blocking_issues(self) -> str:
        """Return a user-facing summary of the current blocking issues."""
        issues = self._state.get("blocking_issues", [])
        if not issues:
            return "Startup is blocked by an unknown bootstrap issue."
        return "; ".join(dict.fromkeys(str(issue) for issue in issues))

    def stream(self, last_event_id: int = 0) -> Iterator[dict[str, Any]]:
        """Yield progress updates for UI (SSE)."""
        while True:
            with self._lock:
                pending = [e for e in self._events if e["id"] > last_event_id]
            if pending:
                for event in pending:
                    last_event_id = event["id"]
                    yield event
                continue
            with self._lock:
                self._event.wait(timeout=5)
            yield {"id": last_event_id, "step": "heartbeat", "status": "pending", "pct": 0, "log": ""}

    def stop_app(self) -> None:
        """Stop running app processes."""
        with self._lock:
            if self._app_process:
                try:
                    self._app_process.terminate()
                    self._app_process.wait(timeout=5)
                except Exception:
                    try:
                        self._app_process.kill()
                    except Exception:
                        pass
                self._app_process = None

    def autostart(self) -> None:
        """Autostart if already installed."""
        if self.bootstrap_config_path.exists() and not self._state["setup_required"]:
            with self._lock:
                self._refresh_readiness_locked()
                if self.is_app_reachable() and self.ui_dist_dir.exists() and self._state["can_launch"]:
                    self._state["status"] = "ready"
                    self._state["app_running"] = True
                    self._save_state()
                    return
            self.start_install()
             
    @property
    def internal_app_url(self) -> str:
        """The private host/port for the app server."""
        from app.config import APP_PORT
        return f"http://127.0.0.1:{APP_PORT}"

    def is_app_reachable(self) -> bool:
        """Check if backend is up by probing localhost:port."""
        from app.config import APP_PORT
        import http.client
        try:
            conn = http.client.HTTPConnection("127.0.0.1", APP_PORT, timeout=1.0)
            conn.request("GET", "/api/health")
            resp = conn.getresponse()
            return resp.status < 500
        except Exception:
            return False

    def restart_install(self) -> dict[str, Any]:
        """Trigger a clean reinstall."""
        with self._lock:
            self._state = models.default_state(self.profile, get_profile_defaults(self.profile), False)
            self._events = []
            self._event_id = 0
            return self.start_install()
