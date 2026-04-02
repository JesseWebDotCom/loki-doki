"""InsightFace buffalo_sc embedding helpers."""

from __future__ import annotations

import math
import os
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Optional

from PIL import Image

from app.config import DATA_DIR
from app.subsystems.live_video.cpu_detector import _numpy_module
from app.subsystems.text.client import ProviderRequestError


MODEL_CACHE_DIR = DATA_DIR / "models" / "face_recognition"
MODEL_ZIP_NAME = "buffalo_sc.zip"
MODEL_URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip"
MODEL_NAME = "w600k_mbf.onnx"
MODEL_INPUT_SIZE = (112, 112)
_SESSION_LOCK = threading.Lock()
_SESSION: Optional[Any] = None


def embed_face(face_image: Image.Image) -> tuple[float, ...]:
    """Return one normalized face embedding."""
    session = _session()
    tensor = _prepare_face(face_image)
    output = session.run(None, {session.get_inputs()[0].name: tensor})[0][0]
    vector = [float(value) for value in output]
    return _normalize_vector(vector)


def average_embeddings(embeddings: list[tuple[float, ...]]) -> tuple[float, ...]:
    """Average and renormalize one identity embedding set."""
    if not embeddings:
        raise ProviderRequestError("No valid face embeddings were produced.")
    length = len(embeddings[0])
    totals = [0.0] * length
    for embedding in embeddings:
        for index, value in enumerate(embedding):
            totals[index] += value
    averaged = [value / len(embeddings) for value in totals]
    return _normalize_vector(averaged)


def cosine_similarity(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    """Return cosine similarity for two normalized embeddings."""
    return float(sum(a * b for a, b in zip(left, right)))


def merge_embeddings(
    left: tuple[float, ...],
    left_count: int,
    right: tuple[float, ...],
    right_count: int,
) -> tuple[float, ...]:
    """Merge two normalized identity vectors using weighted averaging."""
    total = max(left_count, 0) + max(right_count, 0)
    if total <= 0:
        raise ProviderRequestError("Cannot merge face embeddings without sample counts.")
    merged = [
        ((left_value * max(left_count, 0)) + (right_value * max(right_count, 0))) / total
        for left_value, right_value in zip(left, right)
    ]
    return _normalize_vector(merged)


def ensure_face_embedding_model() -> Path:
    """Download and extract the buffalo_sc ArcFace model when missing."""
    model_path = MODEL_CACHE_DIR / MODEL_NAME
    if model_path.exists():
        return model_path
    MODEL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = MODEL_CACHE_DIR / MODEL_ZIP_NAME
    if not zip_path.exists():
        try:
            urllib.request.urlretrieve(MODEL_URL, zip_path)
        except urllib.error.URLError as exc:
            raise ProviderRequestError(
                f"Face embedding model pack '{MODEL_ZIP_NAME}' could not be downloaded from {MODEL_URL}: {exc}"
            ) from exc
    with zipfile.ZipFile(zip_path) as archive:
        archive.extract(MODEL_NAME, MODEL_CACHE_DIR)
    return model_path


def _session() -> Any:
    """Return a cached ONNX runtime session for ArcFace embeddings."""
    global _SESSION
    with _SESSION_LOCK:
        if _SESSION is not None:
            return _SESSION
        _SESSION = _create_session(ensure_face_embedding_model())
        return _SESSION


def _create_session(model_path: Path) -> Any:
    """Create one CPU ONNX runtime embedding session."""
    os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")
    try:
        import onnxruntime as ort  # type: ignore
    except ImportError as exc:
        raise ProviderRequestError("Face recognition requires onnxruntime, but it is not installed.") from exc
    options = ort.SessionOptions()
    options.log_severity_level = 3
    return ort.InferenceSession(
        str(model_path),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )


def _prepare_face(face_image: Image.Image) -> Any:
    """Prepare one face crop for ArcFace inference."""
    numpy = _numpy_module()
    image = face_image.convert("RGB").resize(MODEL_INPUT_SIZE, Image.Resampling.BILINEAR)
    array = numpy.asarray(image, dtype=numpy.float32)
    array = (array - 127.5) / 128.0
    return numpy.transpose(array, (2, 0, 1))[None, :, :, :]


def _normalize_vector(values: list[float]) -> tuple[float, ...]:
    """Normalize one embedding vector to unit length."""
    magnitude = math.sqrt(sum(value * value for value in values))
    if magnitude <= 0.0:
        raise ProviderRequestError("Face embedding model returned a zero-length vector.")
    return tuple(value / magnitude for value in values)
