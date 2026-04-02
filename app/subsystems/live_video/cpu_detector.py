"""CPU-backed YOLO object detection helpers."""

from __future__ import annotations

import base64
import contextlib
import logging
import os
import threading
import urllib.error
import urllib.request
from io import BytesIO
from pathlib import Path
from typing import Any

from app.config import DATA_DIR
from app.providers.types import ProviderSpec
from app.subsystems.live_video.coco import COCO_LABELS
from app.subsystems.text.client import ProviderRequestError


LOGGER = logging.getLogger(__name__)
INPUT_SIZE = 640
ORT_MAX_GUARANTEED_OPSET = 21
MODEL_CACHE_DIR = DATA_DIR / "models" / "object_detection"
MODEL_URLS: dict[str, str] = {
    "yolo11n": "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.onnx",
}
MODEL_ALIASES: dict[str, str] = {
    "yolo11n": "yolo11n",
    "yolo11s": "yolo11n",
    "yolov11n": "yolo11n",
    "yolov11s": "yolo11n",
}
_SESSION_LOCK = threading.Lock()
_SESSIONS: dict[str, Any] = {}


def detect_cpu_objects(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Run CPU object detection for one frame."""
    try:
        image = _decode_image(image_base64)
        session = _session_for_model(provider.model)
        tensor, metadata = _preprocess_image(image)
        output = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    except ProviderRequestError:
        raise
    except Exception as exc:
        raise ProviderRequestError(f"CPU object detection failed: {exc}") from exc
    return tuple(_decode_predictions(output, metadata))


def _decode_image(image_base64: str) -> Any:
    """Decode a base64 image payload into an RGB pillow image."""
    image_module = _image_module()
    raw = base64.b64decode(image_base64)
    with image_module.open(BytesIO(raw)) as image:
        return image.convert("RGB")


def _session_for_model(requested_model: str) -> Any:
    """Return a cached ONNX runtime session for one requested model."""
    resolved_model = _resolve_model_name(requested_model)
    with _SESSION_LOCK:
        session = _SESSIONS.get(resolved_model)
        if session is not None:
            return session
        session = _create_session(_ensure_model_file(resolved_model))
        _SESSIONS[resolved_model] = session
        return session


def _resolve_model_name(requested_model: str) -> str:
    """Map a requested CPU detector model to an available ONNX artifact."""
    normalized = requested_model.strip().lower().removesuffix(".onnx")
    if normalized.endswith(".hef"):
        normalized = "yolo11n"
    return MODEL_ALIASES.get(normalized, "yolo11n")


def _create_session(model_path: Path) -> Any:
    """Create an ONNX runtime session for the given model."""
    try:
        return _load_session(model_path)
    except Exception as exc:
        if not _requires_opset_patch(exc):
            raise ProviderRequestError(f"CPU object detection could not load {model_path.name}: {exc}") from exc
        patched_model_path = _ensure_ort_compatible_model(model_path, ORT_MAX_GUARANTEED_OPSET)
        try:
            return _load_session(patched_model_path)
        except Exception as patched_exc:
            raise ProviderRequestError(
                f"CPU object detection could not load {patched_model_path.name}: {patched_exc}"
            ) from patched_exc


def _ensure_model_file(model_name: str) -> Path:
    """Download the requested ONNX model if it is not already cached."""
    model_path = MODEL_CACHE_DIR / f"{model_name}.onnx"
    if model_path.exists():
        return model_path
    url = MODEL_URLS[model_name]
    model_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlretrieve(url, model_path)
    except urllib.error.URLError as exc:
        raise ProviderRequestError(
            f"CPU object detector model '{model_name}' could not be downloaded from {url}: {exc}"
        ) from exc
    LOGGER.info("Downloaded object detector model %s to %s", model_name, model_path)
    return model_path


def _load_session(model_path: Path) -> Any:
    """Create one ONNX runtime session for a model path."""
    os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")
    try:
        import onnxruntime as ort  # type: ignore
    except ImportError as exc:
        raise ProviderRequestError(
            "CPU object detection requires onnxruntime, but it is not installed."
        ) from exc
    session_options = ort.SessionOptions()
    session_options.log_severity_level = 3
    with _suppress_stderr():
        return ort.InferenceSession(
            str(model_path),
            sess_options=session_options,
            providers=["CPUExecutionProvider"],
        )


def _requires_opset_patch(exc: Exception) -> bool:
    """Return whether this ONNX failure can be recovered via opset patching."""
    message = str(exc)
    return "Opset 22 is under development" in message and "till opset 21" in message


def _ensure_ort_compatible_model(model_path: Path, target_opset: int) -> Path:
    """Write a patched model file with a runtime-compatible ai.onnx opset."""
    patched_path = model_path.with_name(f"{model_path.stem}_opset{target_opset}{model_path.suffix}")
    if patched_path.exists():
        return patched_path
    onnx = _onnx_module()
    model = onnx.load(str(model_path))
    for opset in model.opset_import:
        if opset.domain in ("", "ai.onnx") and opset.version > target_opset:
            opset.version = target_opset
    onnx.save(model, str(patched_path))
    LOGGER.info("Patched %s for onnxruntime compatibility at opset %s", model_path.name, target_opset)
    return patched_path


def _preprocess_image(image: Any) -> tuple[Any, dict[str, float]]:
    """Convert one image into a YOLO ONNX input tensor."""
    image_module = _image_module()
    numpy = _numpy_module()
    width, height = image.size
    scale = min(INPUT_SIZE / width, INPUT_SIZE / height)
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    resized = image.resize((resized_width, resized_height), image_module.Resampling.BILINEAR)
    pad_x = (INPUT_SIZE - resized_width) // 2
    pad_y = (INPUT_SIZE - resized_height) // 2
    canvas = image_module.new("RGB", (INPUT_SIZE, INPUT_SIZE), (114, 114, 114))
    canvas.paste(resized, (pad_x, pad_y))
    array = numpy.asarray(canvas, dtype=numpy.float32) / 255.0
    tensor = numpy.transpose(array, (2, 0, 1))[None, :, :, :]
    metadata = {
        "width": float(width),
        "height": float(height),
        "scale": float(scale),
        "pad_x": float(pad_x),
        "pad_y": float(pad_y),
    }
    return tensor, metadata


def _decode_predictions(output: Any, metadata: dict[str, float]) -> list[dict[str, Any]]:
    """Normalize one YOLO output tensor into shared detection payloads."""
    predictions = _prediction_rows(output)
    boxes, class_ids, scores = _candidate_arrays(predictions)
    if scores.size == 0:
        return []
    keep = scores >= 0.2
    boxes = boxes[keep]
    class_ids = class_ids[keep]
    scores = scores[keep]
    if scores.size == 0:
        return []
    selected = _class_aware_nms(boxes, class_ids, scores, iou_threshold=0.45)
    return _build_detections(boxes[selected], class_ids[selected], scores[selected], metadata)


def _prediction_rows(output: Any) -> Any:
    """Return model output as one row per candidate detection."""
    numpy = _numpy_module()
    predictions = numpy.asarray(output)
    if predictions.ndim != 3:
        raise ProviderRequestError(f"Unsupported detector output shape {predictions.shape}.")
    rows = predictions[0]
    if rows.shape[0] in {84, 85}:
        rows = rows.T
    if rows.shape[1] not in {84, 85}:
        raise ProviderRequestError(f"Unsupported detector output shape {predictions.shape}.")
    return rows


def _candidate_arrays(predictions: Any) -> tuple[Any, Any, Any]:
    """Split raw rows into boxes, class ids, and class confidences."""
    boxes = predictions[:, :4]
    if predictions.shape[1] == 85:
        objectness = predictions[:, 4]
        class_scores = predictions[:, 5:]
        numpy = _numpy_module()
        class_ids = numpy.argmax(class_scores, axis=1)
        scores = objectness * class_scores[numpy.arange(class_scores.shape[0]), class_ids]
    else:
        class_scores = predictions[:, 4:]
        numpy = _numpy_module()
        class_ids = numpy.argmax(class_scores, axis=1)
        scores = class_scores[numpy.arange(class_scores.shape[0]), class_ids]
    return boxes, class_ids.astype("int32"), scores.astype("float32")


def _class_aware_nms(
    boxes: Any,
    class_ids: Any,
    scores: Any,
    iou_threshold: float,
) -> list[int]:
    """Run non-maximum suppression per class."""
    keep: list[int] = []
    numpy = _numpy_module()
    for class_id in numpy.unique(class_ids):
        indices = numpy.where(class_ids == class_id)[0]
        keep.extend(indices[index] for index in _nms(boxes[indices], scores[indices], iou_threshold))
    keep.sort(key=lambda index: float(scores[index]), reverse=True)
    return keep


def _nms(boxes: Any, scores: Any, iou_threshold: float) -> list[int]:
    """Suppress overlapping boxes using score-ordered IoU filtering."""
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        current = int(order[0])
        keep.append(current)
        if order.size == 1:
            break
        remaining = order[1:]
        overlaps = _iou(boxes[current], boxes[remaining])
        order = remaining[overlaps <= iou_threshold]
    return keep


def _iou(box: Any, other_boxes: Any) -> Any:
    """Compute IoU between one center-format box and many center-format boxes."""
    numpy = _numpy_module()
    x1, y1, x2, y2 = _xywh_to_xyxy(box)
    others = numpy.asarray([_xywh_to_xyxy(other_box) for other_box in other_boxes], dtype=numpy.float32)
    inter_x1 = numpy.maximum(x1, others[:, 0])
    inter_y1 = numpy.maximum(y1, others[:, 1])
    inter_x2 = numpy.minimum(x2, others[:, 2])
    inter_y2 = numpy.minimum(y2, others[:, 3])
    inter_width = numpy.maximum(0.0, inter_x2 - inter_x1)
    inter_height = numpy.maximum(0.0, inter_y2 - inter_y1)
    intersection = inter_width * inter_height
    box_area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    other_areas = numpy.maximum(0.0, others[:, 2] - others[:, 0]) * numpy.maximum(0.0, others[:, 3] - others[:, 1])
    union = numpy.maximum(box_area + other_areas - intersection, 1e-6)
    return intersection / union


def _build_detections(
    boxes: Any,
    class_ids: Any,
    scores: Any,
    metadata: dict[str, float],
) -> list[dict[str, Any]]:
    """Convert filtered detections to the shared normalized schema."""
    detections: list[dict[str, Any]] = []
    for box, class_id, score in zip(boxes, class_ids, scores):
        x1, y1, x2, y2 = _restore_box(box, metadata)
        detections.append(
            {
                "label": COCO_LABELS[int(class_id)],
                "confidence": float(score),
                "x": x1 / metadata["width"],
                "y": y1 / metadata["height"],
                "width": (x2 - x1) / metadata["width"],
                "height": (y2 - y1) / metadata["height"],
            }
        )
    return detections


def _restore_box(box: Any, metadata: dict[str, float]) -> tuple[float, float, float, float]:
    """Project one model-space box back onto the source image."""
    x1, y1, x2, y2 = _xywh_to_xyxy(box)
    x1 = (x1 - metadata["pad_x"]) / metadata["scale"]
    y1 = (y1 - metadata["pad_y"]) / metadata["scale"]
    x2 = (x2 - metadata["pad_x"]) / metadata["scale"]
    y2 = (y2 - metadata["pad_y"]) / metadata["scale"]
    width = metadata["width"]
    height = metadata["height"]
    return (
        max(0.0, min(width, x1)),
        max(0.0, min(height, y1)),
        max(0.0, min(width, x2)),
        max(0.0, min(height, y2)),
    )


def _xywh_to_xyxy(box: Any) -> tuple[float, float, float, float]:
    """Convert one center-format box into corner coordinates."""
    cx, cy, width, height = [float(value) for value in box[:4]]
    half_width = width / 2.0
    half_height = height / 2.0
    return cx - half_width, cy - half_height, cx + half_width, cy + half_height


def _numpy_module() -> Any:
    """Return numpy or raise a provider-friendly error."""
    try:
        import numpy  # type: ignore
    except ImportError as exc:
        raise ProviderRequestError("CPU object detection requires numpy, but it is not installed.") from exc
    return numpy


def _image_module() -> Any:
    """Return pillow Image or raise a provider-friendly error."""
    try:
        from PIL import Image  # type: ignore
    except ImportError as exc:
        raise ProviderRequestError("CPU object detection requires Pillow, but it is not installed.") from exc
    return Image


def _onnx_module() -> Any:
    """Return onnx or raise a provider-friendly error."""
    try:
        import onnx  # type: ignore
    except ImportError as exc:
        raise ProviderRequestError(
            "CPU object detection needs the onnx package to patch newer detector models for this runtime."
        ) from exc
    return onnx


@contextlib.contextmanager
def _suppress_stderr() -> Any:
    """Temporarily silence native-library stderr noise during model session creation."""
    stderr_fd = 2
    try:
        saved_stderr = os.dup(stderr_fd)
    except OSError:
        yield
        return
    try:
        with open(os.devnull, "w", encoding="utf-8") as devnull:
            os.dup2(devnull.fileno(), stderr_fd)
            yield
    finally:
        os.dup2(saved_stderr, stderr_fd)
        os.close(saved_stderr)
