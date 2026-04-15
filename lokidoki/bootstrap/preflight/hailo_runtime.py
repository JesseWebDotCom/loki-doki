"""Validate the Hailo HAT runtime on ``pi_hailo``.

Two surfaces:

- :func:`check_hailo_hardware` is a pure detection probe with no side
  effects. It returns a dict the wizard renders directly and the
  pipeline branches on.
- :func:`ensure_hailo_runtime` runs as the ``check-hailo-runtime``
  pipeline step. Missing hardware raises :class:`ProfileFallback` —
  the pipeline rewrites the step list to ``pi_cpu`` and restarts. A
  conflicting kernel module emits ``StepFailed`` with the user-runnable
  remediation; we do not auto-blacklist (sudo).

Per [CLAUDE.md](../../../CLAUDE.md): missing Hailo hardware must fail
gracefully — never crash — and the legacy ``hailo_pci`` module must be
blacklisted before ``hailo1x_pci`` can bind ``/dev/hailo0``.
"""
from __future__ import annotations

import logging
from pathlib import Path

from ..context import StepContext
from ..events import StepFailed, StepLog
from ..pipeline import ProfileFallback, StepHalt


_log = logging.getLogger(__name__)
_STEP_ID = "check-hailo-runtime"

_DEVICE_NODE = Path("/dev/hailo0")
_CLI_PATH = Path("/usr/bin/hailortcli")
_BLACKLIST_FILE = Path("/etc/modprobe.d/blacklist-hailo.conf")
_BLACKLIST_LINE = "blacklist hailo_pci"


def check_hailo_hardware() -> dict:
    """Pure probe — return ``{present, device_node, cli, blacklist_ok, missing}``.

    ``present`` is ``True`` when *both* the device node and the CLI exist.
    ``missing`` lists the human-readable names of any absent prerequisites
    so the wizard can render a checklist instead of a single boolean.
    """
    device_node = _DEVICE_NODE.exists()
    cli = _CLI_PATH.exists()
    blacklist_ok = _read_blacklist_ok()
    missing: list[str] = []
    if not device_node:
        missing.append(str(_DEVICE_NODE))
    if not cli:
        missing.append(str(_CLI_PATH))
    return {
        "present": device_node and cli,
        "device_node": device_node,
        "cli": cli,
        "blacklist_ok": blacklist_ok,
        "missing": missing,
    }


def _read_blacklist_ok() -> bool:
    """True when ``/etc/modprobe.d/blacklist-hailo.conf`` blacklists ``hailo_pci``.

    Returns ``False`` rather than raising on missing/unreadable files —
    callers branch on the bool.
    """
    try:
        text = _BLACKLIST_FILE.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if stripped == _BLACKLIST_LINE:
            return True
    return False


async def ensure_hailo_runtime(ctx: StepContext) -> None:
    """``check-hailo-runtime`` step entry point.

    Hardware missing → emit ``StepFailed`` (non-retryable) and raise
    :class:`ProfileFallback` so the pipeline switches to ``pi_cpu``.
    Kernel-module conflict → emit ``StepFailed`` (retryable) with the
    user-runnable command. Otherwise emit ``StepDone``.
    """
    hw = check_hailo_hardware()
    ctx.emit(
        StepLog(
            step_id=_STEP_ID,
            line=(
                f"hailo: device_node={hw['device_node']} cli={hw['cli']} "
                f"blacklist_ok={hw['blacklist_ok']}"
            ),
        )
    )

    if not hw["present"]:
        remediation = (
            "Hailo HAT not detected. Reseat the HAT and reboot, "
            "or rerun with --profile=pi_cpu to run CPU-only."
        )
        ctx.emit(
            StepFailed(
                step_id=_STEP_ID,
                error=f"missing: {', '.join(hw['missing']) or 'unknown'}",
                remediation=remediation,
                retryable=False,
            )
        )
        raise ProfileFallback(
            "pi_cpu", reason="hailo hardware not detected"
        )

    if not hw["blacklist_ok"]:
        ctx.emit(
            StepFailed(
                step_id=_STEP_ID,
                error="hailo_pci kernel module is not blacklisted",
                remediation=(
                    "Hailo kernel module conflict. Run: "
                    "echo 'blacklist hailo_pci' | sudo tee "
                    "/etc/modprobe.d/blacklist-hailo.conf && sudo reboot"
                ),
                retryable=True,
            )
        )
        # Do NOT auto-fallback — a user with the HAT installed but the
        # blacklist missing should fix the host config and retry.
        raise StepHalt


__all__ = ["check_hailo_hardware", "ensure_hailo_runtime"]
