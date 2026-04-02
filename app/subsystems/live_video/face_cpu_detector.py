"""CPU-backed SCRFD face detection helpers."""

from __future__ import annotations

import contextlib
import logging
import math
import os
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Optional

from PIL import Image

from app.config import DATA_DIR
from app.providers.types import ProviderSpec
from app.subsystems.live_video.cpu_detector import _image_module, _numpy_module
from app.subsystems.text.client import ProviderRequestError


LOGGER = logging.getLogger(__name__)
MODEL_CACHE_DIR = DATA_DIR / "models" / "face_detection"
MODEL_PACKS: dict[str, dict[str, str]] = {
    "scrfd_500m": {
        "zip_name": "buffalo_sc.zip",
        "url": "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip",
        "model_name": "det_500m.onnx",
    },
    "scrfd_10g": {
        "zip_name": "buffalo_l.zip",
        "url": "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip",
        "model_name": "det_10g.onnx",
    },
}
MODEL_ALIASES: dict[str, str] = {
    "scrfd_500m": "scrfd_500m",
    "scrfd_10g": "scrfd_10g",
    "scrfd_10g.hef": "scrfd_500m",
    "yolov5s_personface.hef": "scrfd_500m",
    "yolov5s_personface.onnx": "scrfd_10g",
}
MODEL_INPUT_SIZES: dict[str, tuple[int, int]] = {
    "scrfd_500m": (640, 640),
    "scrfd_10g": (640, 640),
}
_SESSIONS: dict[str, Any] = {}


def detect_cpu_faces(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Run CPU face detection for one frame."""
    image = _decode_image(image_base64)
    model_name = _resolve_model_name(provider.model)
    session = _session_for_model(model_name)
    score_threshold = 0.5
    nms_threshold = 0.4
    input_size = _input_size(session, model_name)
    prepared, resize = _resize_for_detector(image, input_size)
    outputs = _run_session(session, prepared)
    detections = _decode_outputs(session, outputs, resize, input_size, score_threshold)
    return tuple(_nms(detections, nms_threshold))


def _decode_image(image_base64: str) -> Any:
    """Decode a base64 payload into an RGB pillow image."""
    import base64
    from io import BytesIO

    image_module = _image_module()
    raw = base64.b64decode(image_base64)
    with image_module.open(BytesIO(raw)) as image:
        return image.convert("RGB")


def _session_for_model(requested_model: str) -> Any:
    """Return a cached SCRFD session."""
    session = _SESSIONS.get(requested_model)
    if session is not None:
        return session
    session = _create_session(_ensure_model_file(requested_model))
    _SESSIONS[requested_model] = session
    return session


def _resolve_model_name(requested_model: str) -> str:
    """Map a requested face model name to an available CPU artifact."""
    normalized = requested_model.strip().lower()
    return MODEL_ALIASES.get(normalized, "scrfd_500m")


def _ensure_model_file(model_name: str) -> Path:
    """Download and extract the requested detector model when missing."""
    pack = MODEL_PACKS[model_name]
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
                f"CPU face detector pack '{pack['zip_name']}' could not be downloaded from {pack['url']}: {exc}"
            ) from exc
    with zipfile.ZipFile(zip_path) as archive:
        archive.extract(pack["model_name"], MODEL_CACHE_DIR)
    LOGGER.info("Prepared face detector model %s at %s", model_name, model_path)
    return model_path


def _create_session(model_path: Path) -> Any:
    """Create one ONNX runtime session."""
    os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")
    try:
        import onnxruntime as ort  # type: ignore
    except ImportError as exc:
        raise ProviderRequestError("CPU face detection requires onnxruntime, but it is not installed.") from exc
    session_options = ort.SessionOptions()
    session_options.log_severity_level = 3
    with _suppress_stderr():
        return ort.InferenceSession(
            str(model_path),
            sess_options=session_options,
            providers=["CPUExecutionProvider"],
        )


def _input_size(session: Any, model_name: str) -> tuple[int, int]:
    """Return the detector input size."""
    shape = session.get_inputs()[0].shape
    height = _shape_dimension(shape[2])
    width = _shape_dimension(shape[3])
    if height is None or width is None:
        return MODEL_INPUT_SIZES.get(model_name, (640, 640))
    return width, height


def _resize_for_detector(image: Any, input_size: tuple[int, int]) -> tuple[Any, dict[str, float]]:
    """Resize and pad one image for SCRFD."""
    image_module = _image_module()
    numpy = _numpy_module()
    width, height = image.size
    input_width, input_height = input_size
    image_ratio = height / width
    model_ratio = input_height / input_width
    if image_ratio > model_ratio:
        resized_height = input_height
        resized_width = max(1, int(resized_height / image_ratio))
    else:
        resized_width = input_width
        resized_height = max(1, int(resized_width * image_ratio))
    resize = resized_height / height
    resized = image.resize((resized_width, resized_height), image_module.Resampling.BILINEAR)
    canvas = image_module.new("RGB", (input_width, input_height), (0, 0, 0))
    canvas.paste(resized, (0, 0))
    array = numpy.asarray(canvas, dtype=numpy.float32)
    blob = (array[..., ::-1] - 127.5) / 128.0
    blob = numpy.transpose(blob, (2, 0, 1))[None, :, :, :]
    return blob, {"scale": float(resize), "width": float(width), "height": float(height)}


def _run_session(session: Any, blob: Any) -> list[Any]:
    """Execute SCRFD inference."""
    input_name = session.get_inputs()[0].name
    return session.run([output.name for output in session.get_outputs()], {input_name: blob})


def _decode_outputs(
    session: Any,
    outputs: list[Any],
    resize: dict[str, float],
    input_size: tuple[int, int],
    threshold: float,
) -> list[dict[str, Any]]:
    """Decode SCRFD outputs into normalized face detections."""
    numpy = _numpy_module()
    output_count = len(session.get_outputs())
    if output_count == 6:
        strides = [8, 16, 32]
        feature_count = 3
        anchor_count = 2
        use_keypoints = False
    elif output_count == 9:
        strides = [8, 16, 32]
        feature_count = 3
        anchor_count = 2
        use_keypoints = True
    elif output_count == 10:
        strides = [8, 16, 32, 64, 128]
        feature_count = 5
        anchor_count = 1
        use_keypoints = False
    else:
        strides = [8, 16, 32, 64, 128]
        feature_count = 5
        anchor_count = 1
        use_keypoints = True
    input_width, input_height = input_size
    decoded: list[dict[str, Any]] = []
    for index, stride in enumerate(strides):
        scores = outputs[index]
        bbox_preds = outputs[index + feature_count] * stride
        kps_preds = outputs[index + feature_count * 2] * stride if use_keypoints else None
        height = input_height // stride
        width = input_width // stride
        anchor_centers = numpy.stack(numpy.mgrid[:height, :width][::-1], axis=-1).astype(numpy.float32)
        anchor_centers = (anchor_centers * stride).reshape((-1, 2))
        if anchor_count > 1:
            anchor_centers = numpy.stack([anchor_centers] * anchor_count, axis=1).reshape((-1, 2))
        pos_inds = numpy.where(scores >= threshold)[0]
        bboxes = _distance_to_bbox(anchor_centers, bbox_preds)
        pos_scores = scores[pos_inds]
        pos_bboxes = bboxes[pos_inds] / resize["scale"]
        pos_kpss = None
        if use_keypoints and kps_preds is not None:
            kpss = _distance_to_keypoints(anchor_centers, kps_preds).reshape((kps_preds.shape[0], -1, 2))
            pos_kpss = kpss[pos_inds] / resize["scale"]
        for row, score in enumerate(pos_scores):
            x1, y1, x2, y2 = [float(value) for value in pos_bboxes[row]]
            detection = {
                "confidence": float(score),
                "x": max(0.0, x1 / resize["width"]),
                "y": max(0.0, y1 / resize["height"]),
                "width": min(resize["width"], x2) / resize["width"] - max(0.0, x1 / resize["width"]),
                "height": min(resize["height"], y2) / resize["height"] - max(0.0, y1 / resize["height"]),
            }
            if pos_kpss is not None:
                detection["landmarks"] = [
                    {
                        "x": float(max(0.0, min(resize["width"], point[0])) / resize["width"]),
                        "y": float(max(0.0, min(resize["height"], point[1])) / resize["height"]),
                    }
                    for point in pos_kpss[row]
                ]
            decoded.append(detection)
    return sorted(decoded, key=lambda item: item["confidence"], reverse=True)


def _shape_dimension(value: Any) -> Optional[int]:
    """Return one concrete input dimension when available."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _distance_to_bbox(points: Any, distance: Any) -> Any:
    """Decode SCRFD bbox distances."""
    numpy = _numpy_module()
    x1 = points[:, 0] - distance[:, 0]
    y1 = points[:, 1] - distance[:, 1]
    x2 = points[:, 0] + distance[:, 2]
    y2 = points[:, 1] + distance[:, 3]
    return numpy.stack([x1, y1, x2, y2], axis=-1)


def _distance_to_keypoints(points: Any, distance: Any) -> Any:
    """Decode SCRFD 5-point landmarks."""
    numpy = _numpy_module()
    predictions = []
    for index in range(0, distance.shape[1], 2):
        predictions.append(points[:, index % 2] + distance[:, index])
        predictions.append(points[:, index % 2 + 1] + distance[:, index + 1])
    return numpy.stack(predictions, axis=-1)


def _nms(detections: list[dict[str, Any]], threshold: float) -> list[dict[str, Any]]:
    """Suppress overlapping face boxes."""
    kept: list[dict[str, Any]] = []
    for detection in detections:
        if all(_iou(detection, current) <= threshold for current in kept):
            kept.append(detection)
    return kept


def _iou(first: dict[str, Any], second: dict[str, Any]) -> float:
    """Return IoU between two normalized boxes."""
    first_x2 = first["x"] + first["width"]
    first_y2 = first["y"] + first["height"]
    second_x2 = second["x"] + second["width"]
    second_y2 = second["y"] + second["height"]
    inter_x1 = max(first["x"], second["x"])
    inter_y1 = max(first["y"], second["y"])
    inter_x2 = min(first_x2, second_x2)
    inter_y2 = min(first_y2, second_y2)
    inter_width = max(0.0, inter_x2 - inter_x1)
    inter_height = max(0.0, inter_y2 - inter_y1)
    intersection = inter_width * inter_height
    first_area = max(0.0, first["width"]) * max(0.0, first["height"])
    second_area = max(0.0, second["width"]) * max(0.0, second["height"])
    union = max(first_area + second_area - intersection, 1e-6)
    return intersection / union


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
