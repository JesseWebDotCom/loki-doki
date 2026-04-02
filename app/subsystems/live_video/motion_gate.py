"""Platform-agnostic motion gate for live-video detectors."""

from __future__ import annotations

import base64
import threading
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Callable, Optional


MOTION_RATIO_THRESHOLD = 0.01
_STATE_LOCK = threading.Lock()
_STATE: dict[str, "_MotionState"] = {}


@dataclass
class _MotionState:
    """Cached motion detector state for one logical detector stream."""

    subtractor: Any
    last_result: tuple[dict[str, Any], ...]


def detect_with_motion_gate(
    gate_key: str,
    image_base64: str,
    detect_fn: Callable[[], tuple[dict[str, Any], ...]],
) -> tuple[dict[str, Any], ...]:
    """Skip inference when the frame is stable and return the last detector result."""
    cv2 = _cv2_module()
    if cv2 is None:
        return detect_fn()
    frame = _decode_frame(image_base64)
    if frame is None:
        return detect_fn()
    with _STATE_LOCK:
        state = _STATE.get(gate_key)
        if state is None:
            state = _MotionState(
                subtractor=cv2.createBackgroundSubtractorMOG2(history=120, varThreshold=16, detectShadows=False),
                last_result=(),
            )
            _STATE[gate_key] = state
        motion_detected = _apply_motion_gate(state.subtractor, frame, cv2)
        if not motion_detected and state.last_result:
            return state.last_result
    result = detect_fn()
    with _STATE_LOCK:
        state = _STATE.get(gate_key)
        if state is not None:
            state.last_result = result
    return result


def _cv2_module() -> Optional[Any]:
    """Return cv2 when installed."""
    try:
        import cv2  # type: ignore
    except ImportError:
        return None
    return cv2


def _decode_frame(image_base64: str) -> Optional[Any]:
    """Decode one RGB image into a BGR numpy array for OpenCV."""
    try:
        from PIL import Image
        import numpy
    except ImportError:
        return None
    try:
        raw = base64.b64decode(image_base64)
        with Image.open(BytesIO(raw)) as image:
            array = numpy.asarray(image.convert("RGB"))
    except Exception:
        return None
    return array[:, :, ::-1].copy()


def _apply_motion_gate(subtractor: Any, frame: Any, cv2: Any) -> bool:
    """Return whether the current frame contains significant motion."""
    foreground_mask = subtractor.apply(frame)
    motion_pixels = cv2.countNonZero(foreground_mask)
    total_pixels = max(int(foreground_mask.shape[0] * foreground_mask.shape[1]), 1)
    return (motion_pixels / total_pixels) >= MOTION_RATIO_THRESHOLD
