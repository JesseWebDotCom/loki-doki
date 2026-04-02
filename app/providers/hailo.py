"""Hailo detection and validation helpers."""

from __future__ import annotations

import importlib.util
import logging
import os
import re
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from app.config import DATA_DIR
from app.providers.types import CapabilityStatus


LOGGER = logging.getLogger(__name__)
HAILO_OLLAMA_URL = "http://127.0.0.1:8000/api/tags"
HAILO_OLLAMA_DEB_URL = "https://dev-public.hailo.ai/2025_12/Hailo10/hailo_gen_ai_model_zoo_5.1.1_arm64.deb"
HAILO_OLLAMA_CONFIG_PATH = Path("/etc/xdg/hailo-ollama/hailo-ollama.json")
HAILO_SHARED_MODELS_DIR = Path("/usr/share/hailo-ollama/models")
HAILO_USER_MODELS_DIR = Path.home() / ".local" / "share" / "hailo-ollama" / "models"
HAILO_SYSTEM_MODELS_DIR = Path("/usr/share/hailo-models")
HAILO_RUNTIME_LOG_PATH = DATA_DIR / "hailo-ollama-runtime.log"
HEF_VERSION_PATTERN = re.compile(r"\.v(?P<version>\d+\.\d+\.\d+)\.hef$")
MODEL_ALIASES: dict[str, tuple[str, ...]] = {
    "yolov11s.hef": ("yolov11m_h10.hef", "yolov8m_h10.hef"),
    "yolov5s_personface.hef": (),
    "scrfd_10g.hef": ("scrfd_2.5g_h8l.hef",),
}


def _port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def detect_hardware() -> dict[str, Any]:
    """Inspect the local machine for Hailo prerequisites."""
    hef_root = DATA_DIR / "hefs"
    hef_files = sorted(path.name for path in hef_root.glob("*.hef"))
    system_hef_files = sorted(path.name for path in HAILO_SYSTEM_MODELS_DIR.glob("*.hef"))
    user_model_store_ready = HAILO_USER_MODELS_DIR.exists() and (
        HAILO_USER_MODELS_DIR.is_symlink() or (HAILO_USER_MODELS_DIR / "manifests").exists()
    )
    return {
        "device_present": Path("/dev/hailo0").exists(),
        "runtime_cli_present": Path("/usr/bin/hailortcli").exists(),
        "legacy_driver_blacklisted": Path("/etc/modprobe.d/blacklist-hailo-legacy.conf").exists(),
        "hailo_module_loaded": Path("/sys/module/hailo1x_pci").exists(),
        "hailo_platform_importable": importlib.util.find_spec("hailo_platform") is not None,
        "hailo_ollama_config_present": HAILO_OLLAMA_CONFIG_PATH.exists(),
        "hailo_ollama_port_open": _port_open("127.0.0.1", 8000),
        "shared_model_store_present": HAILO_SHARED_MODELS_DIR.exists(),
        "user_model_store_ready": user_model_store_ready,
        "system_model_store_present": HAILO_SYSTEM_MODELS_DIR.exists(),
        "hef_dir": str(hef_root),
        "hef_files": hef_files,
        "system_hef_dir": str(HAILO_SYSTEM_MODELS_DIR),
        "system_hef_files": system_hef_files,
    }


def detect_hailort_version() -> str:
    """Return the installed HailoRT package version."""
    try:
        result = subprocess.run(
            ["dpkg-query", "-W", "-f=${Version}", "h10-hailort"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return "5.1.1"
    if result.returncode != 0:
        return "5.1.1"
    return result.stdout.strip().split("-", 1)[0] or "5.1.1"


def resolve_vision_hef_path(model_name: str) -> Optional[Path]:
    """Return the best local HEF path for the configured vision model."""
    for candidate_name in _candidate_model_names(model_name):
        candidate = Path(candidate_name).expanduser()
        if candidate.exists():
            return candidate
        stem = candidate.stem
        for root in (DATA_DIR / "hefs", HAILO_SYSTEM_MODELS_DIR):
            direct_match = root / candidate.name
            if direct_match.exists():
                return direct_match
            versioned_matches = sorted(root.glob(f"{stem}.v*.hef"))
            if versioned_matches:
                return versioned_matches[-1]
    return None


@contextmanager
def shared_vdevice() -> Iterator[Any]:
    """Yield a Hailo VDevice configured for multi-process sharing."""
    try:
        from hailo_platform import HailoSchedulingAlgorithm, VDevice

        params = VDevice.create_params()
        params.scheduling_algorithm = HailoSchedulingAlgorithm.ROUND_ROBIN
        device = VDevice(params)
    except Exception as exc:  # pragma: no cover - exercised on Pi hardware
        raise RuntimeError(f"Could not create shared Hailo VDevice: {exc}") from exc
    try:
        with device as managed_device:
            yield managed_device
    finally:
        pass


def hailo_device_busy(detail: str) -> bool:
    """Return whether a failure indicates the Hailo device is already reserved."""
    normalized = detail.upper()
    return (
        "HAILO_OUT_OF_PHYSICAL_DEVICES" in normalized
        or "NOT ENOUGH FREE DEVICES" in normalized
        or ("LIBHAILORT FAILED WITH ERROR: 74" in normalized and "HAILO" in normalized)
    )


def stop_hailo_ollama(timeout: float = 10.0) -> bool:
    """Stop local hailo-ollama processes so vision can use the device."""
    pids = _hailo_ollama_pids()
    if not pids:
        return False
    for pid in pids:
        try:
            os.kill(pid, 15)
        except OSError:
            continue
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _hailo_ollama_pids():
            return True
        time.sleep(0.25)
    for pid in _hailo_ollama_pids():
        try:
            os.kill(pid, 9)
        except OSError:
            continue
    return True


def start_hailo_ollama(log_path: Optional[Path] = None) -> bool:
    """Start hailo-ollama if it is not already serving requests."""
    if probe_hailo_llm()["ok"]:
        return False
    handle = (log_path or DATA_DIR / "hailo-ollama.log").open("a", encoding="utf-8")
    subprocess.Popen(
        ["hailo-ollama"],
        stdout=handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    return True


def wait_for_hailo_ollama(timeout: float = 20.0) -> dict[str, Any]:
    """Wait for hailo-ollama to resume after a temporary stop."""
    deadline = time.time() + timeout
    last_probe = {"ok": False, "detail": "hailo-ollama did not start yet."}
    while time.time() < deadline:
        last_probe = probe_hailo_llm()
        if last_probe["ok"]:
            return last_probe
        time.sleep(0.5)
    return last_probe


@contextmanager
def exclusive_hailo_device() -> Iterator[None]:
    """Temporarily stop hailo-ollama so another Hailo workload can run."""
    had_hailo_ollama = bool(_hailo_ollama_pids())
    if had_hailo_ollama:
        LOGGER.info("Temporarily stopping hailo-ollama so Hailo vision can borrow the device.")
        stop_hailo_ollama()
    try:
        yield
    finally:
        if had_hailo_ollama:
            start_hailo_ollama()
            probe = wait_for_hailo_ollama()
            if not probe["ok"]:
                LOGGER.warning("hailo-ollama did not recover cleanly after vision request: %s", probe["detail"])


def _hailo_ollama_pids() -> list[int]:
    """Return active PIDs for local hailo-ollama processes."""
    result = subprocess.run(
        ["ps", "-eo", "pid=,args="],
        check=False,
        capture_output=True,
        text=True,
    )
    pids: list[int] = []
    for raw in result.stdout.splitlines():
        line = raw.strip()
        if not line or "hailo-ollama" not in line:
            continue
        pid_text, _, _cmd = line.partition(" ")
        try:
            pids.append(int(pid_text))
        except ValueError:
            continue
    return pids


def probe_hailo_llm() -> dict[str, Any]:
    """Check whether hailo-ollama is reachable."""
    hardware = detect_hardware()
    if not hardware["hailo_ollama_config_present"]:
        return {"ok": False, "detail": "hailo-gen-ai-model-zoo is not installed."}
    if not hardware["shared_model_store_present"]:
        return {"ok": False, "detail": "The shared Hailo model store is missing from /usr/share/hailo-ollama/models."}
    if not hardware["user_model_store_ready"]:
        return {
            "ok": False,
            "detail": "The user Hailo model store is missing. Recreate ~/.local/share/hailo-ollama/models.",
        }
    try:
        with urllib.request.urlopen(HAILO_OLLAMA_URL, timeout=2.0) as response:
            return {
                "ok": response.status == 200,
                "detail": "hailo-ollama responded on port 8000.",
            }
    except urllib.error.URLError as exc:
        return {"ok": False, "detail": f"hailo-ollama probe failed: {exc.reason}"}
    except Exception as exc:  # pragma: no cover - defensive wrapper
        return {"ok": False, "detail": f"hailo-ollama probe failed: {exc}"}


def ensure_hailo_llm(timeout: float = 8.0) -> dict[str, Any]:
    """Recover hailo-ollama when the runtime is installed but not serving yet."""
    probe = probe_hailo_llm()
    if probe["ok"]:
        return probe
    if not _can_attempt_hailo_ollama_start():
        return probe
    _start_hailo_ollama_process()
    deadline = time.time() + timeout
    latest = probe
    while time.time() < deadline:
        latest = probe_hailo_llm()
        if latest["ok"]:
            return latest
        time.sleep(0.5)
    return latest


def probe_hailo_vision(model_name: str) -> dict[str, Any]:
    """Check whether the requested HEF and runtime hooks exist."""
    hardware = detect_hardware()
    hef_path = resolve_vision_hef_path(model_name)
    if hef_path is None:
        return {
            "ok": False,
            "detail": (
                f"Missing HEF '{model_name}' in {hardware['hef_dir']} "
                f"or {hardware['system_hef_dir']}."
            ),
        }
    if not hardware["hailo_platform_importable"]:
        return {"ok": False, "detail": "Python package 'hailo_platform' is not available."}
    compatibility_error = _device_compatibility_error(hef_path)
    if compatibility_error is not None:
        return {
            "ok": False,
            "detail": compatibility_error,
            "resolved_model": hef_path.name,
        }
    compiled_version = hef_compiled_version(hef_path)
    runtime_version = detect_hailort_version()
    if compiled_version is not None and compiled_version != runtime_version:
        return {
            "ok": False,
            "detail": (
                f"HEF '{hef_path.name}' targets HailoRT {compiled_version}, "
                f"but the installed runtime is {runtime_version}."
            ),
            "resolved_model": hef_path.name,
        }
    alias_detail = ""
    if hef_path.name != Path(model_name).name:
        alias_detail = f"Using packaged HEF '{hef_path.name}' for requested '{model_name}'. "
    return {
        "ok": True,
        "detail": f"{alias_detail}HEF '{hef_path.name}' is present and hailo_platform can be imported.",
        "resolved_model": hef_path.name,
    }


def hef_compiled_version(hef_path: Path) -> Optional[str]:
    """Return the explicit compiled version encoded in one HEF filename when present."""
    resolved_path = hef_path.resolve()
    match = HEF_VERSION_PATTERN.search(resolved_path.name)
    if match is None:
        return None
    return match.group("version")


def _candidate_model_names(model_name: str) -> tuple[str, ...]:
    normalized_name = Path(model_name).name
    aliases = MODEL_ALIASES.get(normalized_name, ())
    return (model_name, *aliases)


def _device_compatibility_error(hef_path: Path) -> Optional[str]:
    normalized_name = hef_path.name.lower()
    if "_h8l" in normalized_name or re.search(r"_h8(?:[._]|$)", normalized_name):
        return (
            f"HEF '{hef_path.name}' targets Hailo-8/Hailo-8L, "
            "but pi_hailo expects Hailo-10H-compatible detector assets."
        )
    return None


def capability_cards(profile: str, models: dict[str, str]) -> list[CapabilityStatus]:
    """Return Phase 2 Hailo-related health cards."""
    if profile != "pi_hailo":
        return []
    hardware = detect_hardware()
    llm_probe = ensure_hailo_llm()
    vision_probe = probe_hailo_vision(models["vision_model"])
    cards = [
        CapabilityStatus(
            key="hailo_hardware",
            label="Hailo hardware",
            status="ok" if hardware["device_present"] else "warn",
            detail="/dev/hailo0 detected." if hardware["device_present"] else "No Hailo device detected.",
        ),
        CapabilityStatus(
            key="hailo_driver",
            label="Hailo driver health",
            status="ok" if hardware["legacy_driver_blacklisted"] else "warn",
            detail=(
                "Legacy hailo_pci blacklist is present."
                if hardware["legacy_driver_blacklisted"]
                else "Legacy hailo_pci blacklist file is missing."
            ),
        ),
        CapabilityStatus(
            key="hailo_llm",
            label="Hailo LLM",
            status="ok" if llm_probe["ok"] else ("warn" if profile == "pi_hailo" else "ok"),
            detail=llm_probe["detail"],
        ),
        CapabilityStatus(
            key="hailo_vision",
            label="Hailo vision",
            status="ok" if vision_probe["ok"] else ("warn" if profile == "pi_hailo" else "ok"),
            detail=vision_probe["detail"],
        ),
    ]
    return cards


def _can_attempt_hailo_ollama_start() -> bool:
    hardware = detect_hardware()
    if not hardware["hailo_ollama_config_present"]:
        return False
    if not hardware["shared_model_store_present"] or not hardware["user_model_store_ready"]:
        return False
    return shutil.which("hailo-ollama") is not None


def _start_hailo_ollama_process() -> None:
    if _hailo_ollama_pids():
        return
    HAILO_RUNTIME_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle = HAILO_RUNTIME_LOG_PATH.open("a", encoding="utf-8")
    try:
        subprocess.Popen(
            ["hailo-ollama"],
            stdout=handle,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
    finally:
        handle.close()
