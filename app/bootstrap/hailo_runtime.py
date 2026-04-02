"""Installer-owned Hailo runtime repair helpers."""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Callable, Optional

from app.providers.hailo import (
    HAILO_OLLAMA_CONFIG_PATH,
    HAILO_OLLAMA_DEB_URL,
    HAILO_SHARED_MODELS_DIR,
    HAILO_SYSTEM_MODELS_DIR,
    HAILO_USER_MODELS_DIR,
    exclusive_hailo_device,
    hef_compiled_version,
    probe_hailo_llm,
    resolve_vision_hef_path,
    shared_vdevice,
)


LogFn = Callable[[str], None]
SYSTEM_HAILO_DIST_PACKAGES = Path("/usr/lib/python3/dist-packages")
HAILO_REQUIRED_APT_PACKAGES = (
    "hailo-h10-all",
    "hailo-models",
    "hailo-tappas-core",
    "python3-hailo-tappas",
    "rpicam-apps-hailo-postprocess",
)
HAILO_DETECTOR_HEF_BASE_URLS: dict[str, str] = {
    "5.2.0": "https://hailo-model-zoo.s3.eu-west-2.amazonaws.com/ModelZoo/Compiled/v5.2.0/hailo10h",
}
HAILO_DETECTOR_HEF_URLS: dict[str, str] = {
    "yolov5s_personface.hef": (
        "https://hailo-model-zoo.s3.eu-west-2.amazonaws.com/"
        "HailoNets/MCPReID/personface_detector/yolov5s_personface/"
        "hailo10h/2026-01-06/yolov5s_personface.hef"
    ),
}


def sudo_available() -> bool:
    """Return whether passwordless sudo is available."""
    result = subprocess.run(
        ["sudo", "-n", "true"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def _apt_package_installed(package_name: str) -> bool:
    """Return whether one Debian package is installed."""
    result = subprocess.run(
        ["dpkg-query", "-W", "-f=${Status}", package_name],
        check=False,
        capture_output=True,
        text=True,
    )
    return "install ok installed" in result.stdout


def ensure_hailo_support_packages(log: LogFn) -> None:
    """Install the Hailo support packages required for detector assets and postprocess code."""
    missing = [package for package in HAILO_REQUIRED_APT_PACKAGES if not _apt_package_installed(package)]
    if not missing:
        return
    if not sudo_available():
        raise RuntimeError(
            "Passwordless sudo is required to install the Hailo support packages: "
            + ", ".join(missing)
        )
    log("Installing Hailo support packages: " + ", ".join(missing) + ".")
    subprocess.run(["sudo", "apt-get", "update"], check=True)
    subprocess.run(["sudo", "apt-get", "install", "-y", *missing], check=True)


def ensure_genai_package(cache_dir: Path, log: LogFn) -> None:
    """Install the official Hailo GenAI package when it is missing."""
    if HAILO_OLLAMA_CONFIG_PATH.exists() and HAILO_SHARED_MODELS_DIR.exists():
        return
    if not sudo_available():
        raise RuntimeError("Passwordless sudo is required to repair the Hailo GenAI package.")
    cache_dir.mkdir(parents=True, exist_ok=True)
    deb_path = cache_dir / "hailo_gen_ai_model_zoo_5.1.1_arm64.deb"
    if not deb_path.exists():
        log(f"Downloading {deb_path.name} from Hailo.")
        urllib.request.urlretrieve(HAILO_OLLAMA_DEB_URL, deb_path)
    log("Installing hailo-gen-ai-model-zoo.")
    subprocess.run(["sudo", "dpkg", "-i", str(deb_path)], check=True)


def ensure_user_model_store(log: LogFn) -> None:
    """Make sure hailo-ollama sees a valid per-user model store."""
    user_root = HAILO_USER_MODELS_DIR.parent
    user_root.mkdir(parents=True, exist_ok=True)
    if HAILO_USER_MODELS_DIR.is_symlink():
        target = HAILO_USER_MODELS_DIR.resolve()
        if target != HAILO_SHARED_MODELS_DIR:
            HAILO_USER_MODELS_DIR.unlink()
            HAILO_USER_MODELS_DIR.symlink_to(HAILO_SHARED_MODELS_DIR)
        return
    if not HAILO_USER_MODELS_DIR.exists():
        HAILO_USER_MODELS_DIR.symlink_to(HAILO_SHARED_MODELS_DIR)
        log("Linked the per-user Hailo model store to the shared model store.")
        return
    if HAILO_USER_MODELS_DIR.is_dir():
        manifests_dir = HAILO_USER_MODELS_DIR / "manifests"
        if not manifests_dir.exists():
            manifests_dir.symlink_to(HAILO_SHARED_MODELS_DIR / "manifests")
            log("Linked the missing user manifests directory for hailo-ollama.")


def ensure_hailo_python_bindings(site_packages_dir: Path, log: LogFn) -> None:
    """Expose only the Hailo Python bindings inside the managed venv."""
    if not SYSTEM_HAILO_DIST_PACKAGES.exists():
        return
    site_packages_dir.mkdir(parents=True, exist_ok=True)
    linked_any = False
    for name in ("hailo_platform", "hailo.cpython-313-aarch64-linux-gnu.so"):
        source = SYSTEM_HAILO_DIST_PACKAGES / name
        target = site_packages_dir / name
        if not source.exists() or target.exists() or target.is_symlink():
            continue
        target.symlink_to(source)
        linked_any = True
    if linked_any:
        log("Linked system Hailo Python bindings into the managed app runtime.")


def detect_hailort_version() -> str:
    """Return the installed HailoRT package version."""
    result = subprocess.run(
        ["dpkg-query", "-W", "-f=${Version}", "h10-hailort"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return "5.1.1"
    return result.stdout.strip().split("-", 1)[0] or "5.1.1"


def ensure_vision_hef(hef_dir: Path, model_name: str, log: LogFn) -> Path:
    """Download the runtime-matched Qwen2-VL HEF and expose a generic symlink."""
    hef_dir.mkdir(parents=True, exist_ok=True)
    runtime_version = detect_hailort_version()
    stem = model_name.removesuffix(".hef")
    versioned_path = hef_dir / f"{stem}.v{runtime_version}.hef"
    generic_path = hef_dir / model_name
    if not versioned_path.exists():
        url = f"https://dev-public.hailo.ai/v{runtime_version}/blob/{model_name}"
        log(f"Downloading {model_name} for HailoRT {runtime_version}.")
        subprocess.run(
            ["curl", "-L", "--fail", "-C", "-", "-o", str(versioned_path), url],
            check=True,
        )
    if generic_path.is_symlink() or generic_path.exists():
        generic_path.unlink()
    generic_path.symlink_to(versioned_path.name)
    return generic_path


def ensure_detector_hef(hef_dir: Path, model_name: str, log: LogFn) -> Path:
    """Download one compiled Hailo detector HEF and expose a generic symlink."""
    resolved_existing = resolve_vision_hef_path(model_name)
    if resolved_existing is not None:
        return resolved_existing
    candidate = Path(model_name).expanduser()
    if candidate.suffix.lower() != ".hef":
        raise RuntimeError(f"Unsupported Hailo detector model '{model_name}'. Expected a .hef file.")
    runtime_version = detect_hailort_version()
    base_url = HAILO_DETECTOR_HEF_BASE_URLS.get(runtime_version)
    hef_dir.mkdir(parents=True, exist_ok=True)
    versioned_path = hef_dir / f"{candidate.stem}.v{runtime_version}.hef"
    generic_path = hef_dir / candidate.name
    direct_url = HAILO_DETECTOR_HEF_URLS.get(candidate.name)
    if direct_url is not None:
        target_path = hef_dir / candidate.name
        if not target_path.exists():
            log(f"Downloading {candidate.name} from the Hailo Model Zoo.")
            _download_with_wget(direct_url, target_path)
        return target_path
    if base_url is None:
        _remove_managed_hef_variants(hef_dir, candidate.stem)
        raise RuntimeError(
            f"No runtime-compatible Hailo detector HEF source is configured for HailoRT {runtime_version}."
        )
    if not versioned_path.exists():
        url = f"{base_url}/{candidate.name}"
        log(
            f"Downloading {candidate.name} from the Hailo Model Zoo "
            f"(compiled v{runtime_version})."
        )
        _download_with_wget(url, versioned_path)
    if generic_path.is_symlink() or generic_path.exists():
        generic_path.unlink()
    generic_path.symlink_to(versioned_path.name)
    return generic_path


def detector_hef_runtime_mismatch(hef_path: Path) -> str | None:
    """Return a human-readable mismatch message when one detector HEF targets a different HailoRT version."""
    compiled_version = hef_compiled_version(hef_path)
    if compiled_version is None:
        return None
    runtime_version = detect_hailort_version()
    if compiled_version == runtime_version:
        return None
    return (
        f"HEF '{hef_path.name}' targets HailoRT {compiled_version}, "
        f"but the installed runtime is {runtime_version}."
    )


def _remove_managed_hef_variants(hef_dir: Path, stem: str) -> None:
    """Remove managed detector HEF files when this runtime has no compatible detector build configured."""
    for path in hef_dir.glob(f"{stem}.v*.hef"):
        path.unlink(missing_ok=True)
    generic_path = hef_dir / f"{stem}.hef"
    if generic_path.exists() or generic_path.is_symlink():
        generic_path.unlink()


def _download_with_wget(url: str, destination: Path) -> None:
    """Download one asset with resume support."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["wget", "-c", "--tries=3", "-O", str(destination), url],
        check=True,
    )


def start_hailo_ollama(log_path: Path) -> tuple[subprocess.Popen[str] | None, Optional[object]]:
    """Start hailo-ollama unless it is already serving requests."""
    if probe_hailo_llm()["ok"]:
        return None, None
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = log_path.open("a", encoding="utf-8")
    process = subprocess.Popen(
        ["hailo-ollama"],
        stdout=handle,
        stderr=subprocess.STDOUT,
        text=True,
        env=os.environ.copy(),
    )
    return process, handle


def wait_for_hailo_ollama(timeout: float = 15.0) -> dict[str, str | bool]:
    """Wait for hailo-ollama to respond on its HTTP API."""
    deadline = time.time() + timeout
    last_probe = {"ok": False, "detail": "hailo-ollama did not start yet."}
    while time.time() < deadline:
        last_probe = probe_hailo_llm()
        if last_probe["ok"]:
            return last_probe
        time.sleep(0.5)
    return last_probe


def validate_hailo_llm_chat(model_name: str, timeout: float = 300.0) -> dict[str, str | bool]:
    """Run a tiny real chat request against hailo-ollama."""
    pull_payload = json.dumps({"model": model_name, "stream": False}).encode("utf-8")
    pull_request = urllib.request.Request(
        "http://127.0.0.1:8000/api/pull",
        data=pull_payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(pull_request, timeout=timeout) as response:
            response.read()
    except Exception as exc:
        return {"ok": False, "detail": f"Model pull failed: {exc}"}
    payload = json.dumps(
        {
            "model": model_name,
            "messages": [{"role": "user", "content": "Reply with exactly HAILO_OK"}],
            "stream": False,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:8000/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
        payload = json.loads(raw)
        message = payload.get("message", {}).get("content", "")
        ok = "HAILO_OK" in message
        detail = message or raw
        return {"ok": ok, "detail": detail}
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}


def validate_hailo_vision(hef_path: Path) -> dict[str, str | bool]:
    """Run a tiny real VLM request against the HEF on-device."""
    try:
        import numpy as np
        from hailo_platform.genai import VLM

        with exclusive_hailo_device():
            with shared_vdevice() as vdevice:
                with VLM(vdevice, str(hef_path), optimize_memory_on_device=False) as vlm:
                    shape = tuple(vlm.input_frame_shape())
                    dtype = vlm.input_frame_format_type()
                    frame = np.zeros(shape, dtype=dtype)
                    prompt = [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "Describe this image in one short sentence."},
                                {"type": "image"},
                            ],
                        }
                    ]
                    response = vlm.generate_all(
                        prompt,
                        frames=[frame],
                        max_generated_tokens=32,
                        do_sample=False,
                        timeout_ms=300000,
                    )
        detail = str(response).strip()
        return {"ok": bool(detail), "detail": detail}
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}
