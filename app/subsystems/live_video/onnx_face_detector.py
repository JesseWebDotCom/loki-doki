"""ONNX/CoreML-backed person/face detection helpers."""

from __future__ import annotations

import contextlib
import logging
import os
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Optional

from app.config import DATA_DIR
from app.providers.types import ProviderSpec
from app.subsystems.live_video.face_cpu_detector import _decode_image, _resize_for_detector
from app.subsystems.live_video.personface_decoder import decode_personface_nms_outputs, decode_personface_raw_outputs
from app.subsystems.text.client import ProviderRequestError


LOGGER = logging.getLogger(__name__)
MODEL_CACHE_DIR = DATA_DIR / "models" / "face_detection"
MODEL_PACKS: dict[str, dict[str, str]] = {
    "yolov5s_personface": {
        "zip_name": "yolov5s_personface.zip",
        "url": (
            "https://hailo-model-zoo.s3.eu-west-2.amazonaws.com/"
            "HailoNets/MCPReID/personface_detector/yolov5s_personface/2023-04-25/yolov5s_personface.zip"
        ),
        "model_name": "yolov5s_personface.onnx",
    }
}
MODEL_ALIASES: dict[str, str] = {
    "yolov5s_personface": "yolov5s_personface",
    "yolov5s_personface.onnx": "yolov5s_personface",
}
_SESSION_LOCK = threading.Lock()
_SESSIONS: dict[str, Any] = {}


def detect_onnx_faces(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Run the ONNX/CoreML person-face detector for one frame."""
    try:
        image = _decode_image(image_base64)
        model_name = _resolve_model_name(provider.model)
        session = _session_for_model(model_name)
        input_size = _input_size(session)
        prepared, resize = _resize_for_detector(image, input_size)
        outputs = session.run(None, {session.get_inputs()[0].name: prepared})
    except ProviderRequestError:
        raise
    except Exception as exc:
        raise ProviderRequestError(f"ONNX face detection failed: {exc}") from exc
    metadata = {**resize, "input_size": input_size}
    if _uses_raw_personface_outputs(outputs):
        return tuple(decode_personface_raw_outputs(outputs, metadata))
    return tuple(decode_personface_nms_outputs(outputs, metadata))


def ensure_personface_model(model_name: str) -> Path:
    """Download and extract the requested ONNX person-face detector when missing."""
    resolved_model = _resolve_model_name(model_name)
    pack = MODEL_PACKS[resolved_model]
    model_path = MODEL_CACHE_DIR / pack["model_name"]
    if model_path.exists():
        return model_path
    MODEL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = MODEL_CACHE_DIR / pack["zip_name"]
    if not zip_path.exists():
        try:
            urllib.request.urlretrieve(pack["url"], zip_path)
        except urllib.error.URLError as exc:
            raise ProviderRequestError(
                f"ONNX face detector pack '{pack['zip_name']}' could not be downloaded from {pack['url']}: {exc}"
            ) from exc
    with zipfile.ZipFile(zip_path) as archive:
        archive.extract(pack["model_name"], MODEL_CACHE_DIR)
    LOGGER.info("Prepared ONNX face detector model %s at %s", resolved_model, model_path)
    return model_path


def _session_for_model(requested_model: str) -> Any:
    """Return a cached ONNX runtime session."""
    with _SESSION_LOCK:
        session = _SESSIONS.get(requested_model)
        if session is not None:
            return session
        session = _create_session(ensure_personface_model(requested_model))
        _SESSIONS[requested_model] = session
        return session


def _resolve_model_name(requested_model: str) -> str:
    """Normalize one requested model identifier to a cached artifact name."""
    normalized = requested_model.strip().lower()
    return MODEL_ALIASES.get(normalized, "yolov5s_personface")


def _uses_raw_personface_outputs(outputs: list[Any]) -> bool:
    """Return whether the ONNX model returned raw YOLOv5 head tensors."""
    return bool(outputs) and all(hasattr(output, "shape") and len(output.shape) == 5 for output in outputs)


def _create_session(model_path: Path) -> Any:
    """Create one ONNX runtime session with CoreML preferred on Mac."""
    os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")
    try:
        import onnxruntime as ort  # type: ignore
    except ImportError as exc:
        raise ProviderRequestError("ONNX face detection requires onnxruntime, but it is not installed.") from exc
    session_options = ort.SessionOptions()
    session_options.log_severity_level = 3
    providers = _provider_order(ort)
    with _suppress_stderr():
        return ort.InferenceSession(
            str(model_path),
            sess_options=session_options,
            providers=providers,
        )


def _provider_order(ort: Any) -> list[str]:
    """Return execution-provider order with CoreML preferred when available."""
    available = set(ort.get_available_providers())
    providers = []
    if "CoreMLExecutionProvider" in available:
        providers.append("CoreMLExecutionProvider")
    providers.append("CPUExecutionProvider")
    return providers


def _input_size(session: Any) -> tuple[int, int]:
    """Return the detector input size."""
    shape = session.get_inputs()[0].shape
    height = _shape_dimension(shape[2]) if len(shape) > 2 else None
    width = _shape_dimension(shape[3]) if len(shape) > 3 else None
    if height is None or width is None:
        return (640, 640)
    return width, height


def _shape_dimension(value: Any) -> Optional[int]:
    """Return one concrete dimension when available."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@contextlib.contextmanager
def _suppress_stderr() -> Any:
    """Silence native-library stderr noise during session creation."""
    try:
        saved_stderr = os.dup(2)
    except OSError:
        yield
        return
    try:
        with open(os.devnull, "w", encoding="utf-8") as devnull:
            os.dup2(devnull.fileno(), 2)
            yield
    finally:
        os.dup2(saved_stderr, 2)
        os.close(saved_stderr)
