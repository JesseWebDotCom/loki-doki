"""Wake word source and detection helpers."""

from __future__ import annotations

import base64
import json
import threading
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from app.config import DATA_DIR, ROOT_DIR


OWW_TARGET_SAMPLE_RATE = 16_000
OWW_FRAME_SAMPLES = 1_280
DEFAULT_WAKEWORD_THRESHOLD = 0.35
WAKEWORD_MODELS_DIR = ROOT_DIR / "assets" / "models" / "wakeword"
CUSTOM_WAKEWORD_MODELS_DIR = DATA_DIR / "wakeword" / "models"
CUSTOM_WAKEWORD_REGISTRY_PATH = DATA_DIR / "wakeword" / "custom_models.json"
STANDARD_OPENWAKEWORD_MODELS: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    ("alexa", "Alexa", "alexa_v0.1.onnx", ("alexa",)),
    ("hey_jarvis", "Hey Jarvis", "hey_jarvis_v0.1.onnx", ("hey jarvis",)),
    ("hey_mycroft", "Hey Mycroft", "hey_mycroft_v0.1.onnx", ("hey mycroft",)),
    ("hey_rhasspy", "Hey Rhasspy", "hey_rhasspy_v0.1.onnx", ("hey rhasspy",)),
)


class WakewordError(RuntimeError):
    """Raised when wakeword detection cannot run."""


@dataclass(frozen=True)
class WakewordSource:
    """One installed wakeword model."""

    id: str
    label: str
    model_path: str
    phrases: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-safe payload."""
        return {
            "id": self.id,
            "label": self.label,
            "model_path": self.model_path,
            "phrases": list(self.phrases),
            "installed": Path(self.model_path).exists(),
        }


@dataclass(frozen=True)
class WakewordDetectionResult:
    """One wakeword detection response."""

    detected: bool
    score: float
    ready: bool
    detail: str
    model_id: str

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-safe payload."""
        return {
            "detected": self.detected,
            "score": round(self.score, 4),
            "ready": self.ready,
            "detail": self.detail,
            "model_id": self.model_id,
        }


def list_wakeword_sources() -> list[WakewordSource]:
    """Return installed built-in and custom wakeword models."""
    sources = [
        WakewordSource(
            id="loki_doki",
            label="LokiDoki",
            model_path=str(WAKEWORD_MODELS_DIR / "loki_doki.onnx"),
            phrases=("loki doki",),
        ),
    ]
    standard_dir = _openwakeword_standard_models_dir()
    if standard_dir is not None:
        for model_id, label, filename, phrases in STANDARD_OPENWAKEWORD_MODELS:
            sources.append(
                WakewordSource(
                    id=model_id,
                    label=label,
                    model_path=str(standard_dir / filename),
                    phrases=phrases,
                )
            )
    for item in _load_custom_wakeword_registry():
        sources.append(
            WakewordSource(
                id=str(item.get("id") or "").strip(),
                label=str(item.get("label") or item.get("id") or "Custom Wakeword").strip(),
                model_path=str(CUSTOM_WAKEWORD_MODELS_DIR / f"{str(item.get('id') or '').strip()}.onnx"),
                phrases=tuple(str(phrase).strip() for phrase in item.get("phrases", []) if str(phrase).strip()),
            )
        )
    return [source for source in sources if Path(source.model_path).exists()]


def get_wakeword_source(model_id: str) -> WakewordSource:
    """Return one installed wakeword model by id."""
    normalized = str(model_id or "").strip() or "loki_doki"
    for source in list_wakeword_sources():
        if source.id == normalized:
            return source
    raise WakewordError(f"Wakeword model '{normalized}' is not installed.")


def wakeword_runtime_status(model_id: str) -> dict[str, object]:
    """Return wakeword availability for one selected model."""
    try:
        source = get_wakeword_source(model_id)
    except WakewordError as exc:
        return {
            "ready": False,
            "detail": str(exc),
            "engine_available": _openwakeword_importable(),
            "model_id": str(model_id or "").strip() or "loki_doki",
            "source": None,
        }
    runtime_ready, runtime_detail = _openwakeword_runtime_ready()
    if not runtime_ready:
        return {
            "ready": False,
            "detail": runtime_detail,
            "engine_available": _openwakeword_importable(),
            "model_id": source.id,
            "source": source.to_dict(),
        }
    return {
        "ready": True,
        "detail": "Wakeword detection is ready.",
        "engine_available": True,
        "model_id": source.id,
        "source": source.to_dict(),
    }


def install_wakeword_from_url(
    model_id: str,
    url: str,
    *,
    label: str = "",
    phrases: tuple[str, ...] = (),
) -> dict[str, object]:
    """Download and register one custom wakeword model."""
    normalized_id = _normalize_model_id(model_id)
    normalized_url = str(url).strip()
    if not normalized_url.endswith(".onnx"):
        raise WakewordError("Wakeword URL must point to a .onnx file.")
    CUSTOM_WAKEWORD_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    target_path = CUSTOM_WAKEWORD_MODELS_DIR / f"{normalized_id}.onnx"
    urllib.request.urlretrieve(normalized_url, target_path)
    _save_custom_wakeword_registry(
        [
            *[entry for entry in _load_custom_wakeword_registry() if str(entry.get("id")) != normalized_id],
            {
                "id": normalized_id,
                "label": label.strip() or normalized_id,
                "phrases": list(phrases),
                "source_type": "url",
                "source_value": normalized_url,
            },
        ]
    )
    return {"ok": True, "model_id": normalized_id, "model_path": str(target_path), "source_url": normalized_url}


def install_wakeword_from_upload(
    model_id: str,
    upload_name: str,
    data_url: str,
    *,
    label: str = "",
    phrases: tuple[str, ...] = (),
) -> dict[str, object]:
    """Persist one uploaded custom wakeword model."""
    normalized_id = _normalize_model_id(model_id)
    payload = str(data_url or "").strip()
    if "," not in payload:
        raise WakewordError("Wakeword upload payload is invalid.")
    _, encoded = payload.split(",", 1)
    try:
        model_bytes = base64.b64decode(encoded)
    except Exception as exc:
        raise WakewordError("Wakeword upload could not be decoded.") from exc
    CUSTOM_WAKEWORD_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    target_path = CUSTOM_WAKEWORD_MODELS_DIR / f"{normalized_id}.onnx"
    target_path.write_bytes(model_bytes)
    _save_custom_wakeword_registry(
        [
            *[entry for entry in _load_custom_wakeword_registry() if str(entry.get("id")) != normalized_id],
            {
                "id": normalized_id,
                "label": label.strip() or normalized_id,
                "phrases": list(phrases),
                "source_type": "upload",
                "source_value": str(upload_name).strip(),
            },
        ]
    )
    return {"ok": True, "model_id": normalized_id, "model_path": str(target_path), "source_name": str(upload_name).strip()}


class WakewordSessionManager:
    """Manage per-session wakeword detectors."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._detectors: dict[tuple[str, str], _WakewordStreamDetector] = {}

    def detect(
        self,
        session_id: str,
        model_id: str,
        threshold: float,
        audio_base64: str,
        sample_rate: int,
    ) -> WakewordDetectionResult:
        """Run wakeword detection for one audio chunk."""
        source = get_wakeword_source(model_id)
        pcm_bytes = _decode_audio_chunk(audio_base64)
        if not pcm_bytes:
            return WakewordDetectionResult(
                detected=False,
                score=0.0,
                ready=True,
                detail="No audio samples were received.",
                model_id=source.id,
            )
        detector = self._get_or_create_detector(session_id, source, threshold)
        detected, score = detector.process_pcm16_chunk(pcm_bytes, sample_rate)
        return WakewordDetectionResult(
            detected=detected,
            score=score,
            ready=True,
            detail="Wakeword detected." if detected else "Listening for wakeword.",
            model_id=source.id,
        )

    def reset(self, session_id: str) -> None:
        """Reset one detector session."""
        with self._lock:
            keys = [key for key in self._detectors if key[0] == session_id]
            for key in keys:
                self._detectors.pop(key, None)

    def _get_or_create_detector(
        self,
        session_id: str,
        source: WakewordSource,
        threshold: float,
    ) -> "_WakewordStreamDetector":
        key = (session_id, source.id)
        with self._lock:
            detector = self._detectors.get(key)
            if detector is None or detector.threshold != float(threshold):
                detector = _WakewordStreamDetector(source.model_path, threshold)
                self._detectors[key] = detector
            return detector


class _WakewordStreamDetector:
    """Small openWakeWord streaming wrapper."""

    def __init__(self, model_path: str, threshold: float) -> None:
        np = _numpy()
        self._model_path = str(model_path)
        self.threshold = float(threshold)
        self._buffer = np.zeros(0, dtype=np.int16)
        self._model: Optional[Any] = None

    def process_pcm16_chunk(self, pcm_bytes: bytes, sample_rate: int) -> tuple[bool, float]:
        """Process one PCM16 chunk and return detection state."""
        np = _numpy()
        chunk = np.frombuffer(pcm_bytes, dtype=np.int16)
        if chunk.size == 0:
            return (False, 0.0)
        prepared = _resample_pcm16(chunk, sample_rate, OWW_TARGET_SAMPLE_RATE)
        if prepared.size == 0:
            return (False, 0.0)
        self._buffer = np.concatenate((self._buffer, prepared))
        model = self._ensure_model_loaded()
        peak_score = 0.0
        while self._buffer.size >= OWW_FRAME_SAMPLES:
            frame = self._buffer[:OWW_FRAME_SAMPLES]
            self._buffer = self._buffer[OWW_FRAME_SAMPLES:]
            model.predict(frame)
            score = _latest_prediction_score(model)
            peak_score = max(peak_score, score)
            if score >= self.threshold:
                self.reset()
                return (True, peak_score)
        return (False, peak_score)

    def reset(self) -> None:
        """Reset detector state."""
        np = _numpy()
        self._buffer = np.zeros(0, dtype=np.int16)
        if self._model is not None:
            self._model.reset()

    def _ensure_model_loaded(self) -> Any:
        if self._model is not None:
            return self._model
        model_file = Path(self._model_path)
        if not model_file.exists():
            raise WakewordError(f"Wakeword model is missing: {model_file}")
        try:
            from openwakeword.model import Model  # type: ignore
            from openwakeword.utils import download_models  # type: ignore
        except Exception as exc:
            raise WakewordError("openwakeword is not installed in the active app environment.") from exc
        try:
            download_models()
            self._model = Model(wakeword_models=[str(model_file)])
        except Exception as exc:
            raise WakewordError(f"openwakeword runtime is not ready: {exc}") from exc
        return self._model


def _decode_audio_chunk(audio_base64: str) -> bytes:
    payload = str(audio_base64 or "").strip()
    if not payload:
        return b""
    try:
        return base64.b64decode(payload)
    except Exception as exc:
        raise WakewordError("Wakeword audio chunk could not be decoded.") from exc


def _resample_pcm16(chunk: np.ndarray, sample_rate: int, target_rate: int) -> np.ndarray:
    np = _numpy()
    if sample_rate <= 0:
        raise WakewordError("Wakeword audio sample rate must be positive.")
    if sample_rate == target_rate:
        return chunk.astype(np.int16, copy=False)
    duration = chunk.size / float(sample_rate)
    target_length = max(int(round(duration * target_rate)), 1)
    if target_length == chunk.size:
        return chunk.astype(np.int16, copy=False)
    source_positions = np.linspace(0.0, 1.0, num=chunk.size, endpoint=False, dtype=np.float32)
    target_positions = np.linspace(0.0, 1.0, num=target_length, endpoint=False, dtype=np.float32)
    resampled = np.interp(target_positions, source_positions, chunk.astype(np.float32))
    return np.clip(resampled, -32768.0, 32767.0).astype(np.int16)


def _latest_prediction_score(model: Any) -> float:
    score = 0.0
    prediction_buffer = getattr(model, "prediction_buffer", {})
    for values in prediction_buffer.values():
        if not values:
            continue
        score = max(score, float(list(values)[-1]))
    return score


def _openwakeword_importable() -> bool:
    try:
        from openwakeword.model import Model  # type: ignore  # noqa: F401
    except Exception:
        return False
    return True


def _openwakeword_runtime_ready() -> tuple[bool, str]:
    try:
        import openwakeword  # type: ignore
        from openwakeword.utils import download_models  # type: ignore
    except Exception:
        return (False, "openwakeword is not installed in the active app environment.")
    try:
        download_models()
    except Exception as exc:
        return (False, f"openwakeword could not download its internal models: {exc}")
    resources_dir = Path(openwakeword.__file__).resolve().parent / "resources" / "models"
    required = [
        resources_dir / "melspectrogram.onnx",
        resources_dir / "embedding_model.onnx",
    ]
    missing = [path.name for path in required if not path.exists()]
    if missing:
        return (False, f"openwakeword resources are missing: {', '.join(missing)}")
    return (True, "Wakeword detection is ready.")


def _openwakeword_standard_models_dir() -> Optional[Path]:
    try:
        import openwakeword  # type: ignore
    except Exception:
        return None
    candidate = Path(openwakeword.__file__).resolve().parent / "resources" / "models"
    if not candidate.exists():
        return None
    return candidate


def _numpy():
    try:
        import numpy as np  # type: ignore
    except Exception as exc:
        raise WakewordError("numpy is required for wakeword detection.") from exc
    return np


def _load_custom_wakeword_registry() -> list[dict[str, Any]]:
    if not CUSTOM_WAKEWORD_REGISTRY_PATH.exists():
        return []
    try:
        payload = json.loads(CUSTOM_WAKEWORD_REGISTRY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list):
        return []
    return [dict(item) for item in payload if isinstance(item, dict)]


def _save_custom_wakeword_registry(entries: list[dict[str, Any]]) -> None:
    CUSTOM_WAKEWORD_REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    CUSTOM_WAKEWORD_REGISTRY_PATH.write_text(f"{json.dumps(entries, indent=2)}\n", encoding="utf-8")


def _normalize_model_id(value: str) -> str:
    normalized = "".join(character if character.isalnum() else "-" for character in str(value).strip().lower())
    normalized = "-".join(part for part in normalized.split("-") if part)
    if not normalized:
        raise WakewordError("Wakeword model id is required.")
    return normalized
