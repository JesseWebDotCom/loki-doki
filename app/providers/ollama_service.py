"""Helpers for keeping the local Ollama service available."""

from __future__ import annotations

import logging
import shutil
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from app.providers.ollama import available_models, probe_provider_endpoint
from app.providers.types import ProviderSpec


OLLAMA_ENDPOINT = "http://127.0.0.1:11434"
CPU_OLLAMA_PROFILES = {"mac", "pi_cpu"}


def ensure_ollama_service(
    profile: str,
    logger: logging.Logger,
    timeout: float = 12.0,
    log_path: Optional[Path] = None,
) -> dict[str, str | bool]:
    """Ensure Ollama is reachable for CPU-backed text profiles."""
    if profile not in CPU_OLLAMA_PROFILES:
        return {"ok": True, "started": False, "detail": f"Ollama startup is not required for {profile}."}
    result = ensure_ollama_endpoint(logger, timeout=timeout, log_path=log_path)
    if result["ok"] and result.get("started"):
        logger.info("Ollama endpoint recovered for the %s profile.", profile)
    return result


def ensure_ollama_endpoint(
    logger: logging.Logger,
    timeout: float = 12.0,
    log_path: Optional[Path] = None,
) -> dict[str, str | bool]:
    """Ensure the local Ollama HTTP endpoint is reachable."""
    probe = _probe_ollama()
    if probe["ok"]:
        return {"ok": True, "started": False, "detail": str(probe["detail"])}
    binary = shutil.which("ollama")
    if not binary:
        return {"ok": False, "started": False, "detail": "Ollama CLI is not installed or not on PATH."}
    if _ollama_serve_running():
        return _wait_for_ollama(timeout)
    logger.info("Starting Ollama automatically.")
    _start_ollama_process(binary, log_path)
    result = _wait_for_ollama(timeout)
    result["started"] = True
    return result


def ensure_ollama_models(
    models: list[str],
    logger: logging.Logger,
    timeout: float = 12.0,
    log_path: Optional[Path] = None,
) -> dict[str, str | bool]:
    """Ensure the requested local Ollama models are installed."""
    requested = [model.strip() for model in models if model.strip()]
    if not requested:
        return {"ok": True, "changed": False, "detail": "No Ollama models are required."}
    service = ensure_ollama_endpoint(logger, timeout=timeout, log_path=log_path)
    if not service["ok"]:
        return {"ok": False, "changed": False, "detail": str(service["detail"])}
    installed = _available_local_models()
    missing = [model for model in dict.fromkeys(requested) if model not in installed]
    if not missing:
        return {"ok": True, "changed": False, "detail": "All required Ollama models are installed."}
    binary = shutil.which("ollama")
    if not binary:
        return {"ok": False, "changed": False, "detail": "Ollama CLI is not installed or not on PATH."}
    for model in missing:
        logger.info("Pulling missing Ollama model: %s", model)
        _pull_model(binary, model, log_path)
    return {"ok": True, "changed": True, "detail": f"Installed missing Ollama models: {', '.join(missing)}."}


def _probe_ollama() -> dict[str, str | bool]:
    provider = ProviderSpec(
        name="ollama",
        backend="ollama",
        model="startup-check",
        acceleration="cpu",
        endpoint=OLLAMA_ENDPOINT,
    )
    return probe_provider_endpoint(provider, timeout=0.5)


def _ollama_serve_running() -> bool:
    try:
        result = subprocess.run(
            ["ps", "-axo", "command="],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return False
    return any("ollama serve" in line for line in result.stdout.splitlines())


def _start_ollama_process(binary: str, log_path: Optional[Path]) -> None:
    stdout_handle = subprocess.DEVNULL
    if log_path is not None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        stdout_handle = log_path.open("a", encoding="utf-8")
    try:
        subprocess.Popen(
            [binary, "serve"],
            stdout=stdout_handle,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
    finally:
        if log_path is not None and stdout_handle is not subprocess.DEVNULL:
            stdout_handle.close()


def _wait_for_ollama(timeout: float) -> dict[str, str | bool]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        probe = _probe_ollama()
        if probe["ok"]:
            return {"ok": True, "started": False, "detail": str(probe["detail"])}
        time.sleep(0.25)
    return {
        "ok": False,
        "started": False,
        "detail": f"Ollama did not become ready at {OLLAMA_ENDPOINT} within {timeout:.0f}s.",
    }


def _available_local_models() -> set[str]:
    try:
        return available_models(OLLAMA_ENDPOINT, timeout=1.0)
    except Exception:
        return set()


def _pull_model(binary: str, model: str, log_path: Optional[Path]) -> None:
    with _log_handle(log_path) as log_handle:
        subprocess.run(
            [binary, "pull", model],
            check=True,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            text=True,
        )


@contextmanager
def _log_handle(log_path: Optional[Path]):
    if log_path is None:
        handle = open("/dev/null", "a", encoding="utf-8")
    else:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handle = log_path.open("a", encoding="utf-8")
    try:
        yield handle
    finally:
        handle.close()
