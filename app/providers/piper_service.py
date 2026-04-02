"""Piper voice catalog, install, and synthesis helpers."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from pathlib import Path
from typing import Any, Optional
from urllib.error import URLError

from app.config import DATA_DIR


VOICE_DIR = DATA_DIR / "piper" / "voices"
CUSTOM_VOICE_REGISTRY_PATH = DATA_DIR / "piper" / "custom_voices.json"
UPSTREAM_VOICE_CATALOG_PATH = DATA_DIR / "piper" / "voices_catalog.json"
UPSTREAM_VOICE_CATALOG_URL = "https://huggingface.co/rhasspy/piper-voices/raw/main/voices.json"
UPSTREAM_CATALOG_TTL_SECONDS = 24 * 60 * 60
_VOICE_CACHE: dict[str, Any] = {}
_VOICE_CACHE_LOCK = threading.Lock()
CURATED_VOICE_IDS = {
    "en_US-lessac-medium": {
        "label": "Lessac",
        "description": "Clear neutral American English voice.",
        "gender": "neutral",
    },
    "en_US-amy-medium": {
        "label": "Amy",
        "description": "Warmer conversational American English voice.",
        "gender": "female",
    },
    "en_US-joe-medium": {
        "label": "Joe",
        "description": "Deeper American English voice.",
        "gender": "male",
    },
}


def voice_catalog() -> list[dict[str, object]]:
    """Return the curated Piper voice catalog with install status."""
    installed = installed_voice_ids()
    ready = piper_binary_path() is not None
    return [
        {
            **voice,
            "installed": voice["id"] in installed,
            "synthesis_ready": ready and voice["id"] in installed,
        }
        for voice in _voice_catalog_entries()
    ]


def voice_catalog_status(*, force_refresh: bool = False) -> dict[str, object]:
    """Return Piper upstream catalog sync status."""
    payload = _upstream_catalog_payload(force_refresh=force_refresh)
    return {
        "source_url": UPSTREAM_VOICE_CATALOG_URL,
        "fetched_at": float(payload.get("fetched_at") or 0.0),
        "voice_count": len(payload.get("voices") or []),
        "used_cache": bool(payload.get("used_cache")),
        "stale": bool(payload.get("stale")),
    }


def piper_binary_path() -> Optional[Path]:
    """Return the best local Piper binary path."""
    managed_binary = DATA_DIR / "app-venv" / "bin" / "piper"
    if managed_binary.exists():
        return managed_binary
    venv_binary = Path(sys.executable).resolve().parent / "piper"
    if venv_binary.exists():
        return venv_binary
    binary = shutil.which("piper")
    if binary:
        return Path(binary)
    return None


def installed_voice_ids() -> set[str]:
    """Return installed Piper voice ids."""
    if not VOICE_DIR.exists():
        return set()
    installed: set[str] = set()
    for voice in _voice_catalog_entries():
        voice_id = str(voice["id"])
        if model_path(voice_id).exists() and config_path(voice_id).exists():
            installed.add(voice_id)
    return installed


def piper_status(selected_voice: str) -> dict[str, object]:
    """Return Piper runtime status and current install state."""
    binary = piper_binary_path()
    installed = installed_voice_ids()
    return {
        "binary_ready": binary is not None,
        "binary_path": str(binary) if binary else "",
        "installed_voices": sorted(installed),
        "selected_voice_installed": selected_voice in installed if selected_voice else False,
    }


def install_voice(voice_id: str) -> dict[str, object]:
    """Download a Piper voice model and config."""
    voice = _catalog_voice(voice_id)
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    model_target = model_path(voice_id)
    config_target = config_path(voice_id)
    model_url = str(voice.get("model_url") or "").strip()
    config_url = str(voice.get("config_url") or "").strip()
    if not model_target.exists():
        if not model_url:
            raise RuntimeError(f"Piper voice '{voice_id}' is missing a model URL.")
        urllib.request.urlretrieve(model_url, model_target)
    if not config_target.exists():
        if not config_url:
            raise RuntimeError(f"Piper voice '{voice_id}' is missing a config URL.")
        urllib.request.urlretrieve(config_url, config_target)
    warm_voice(voice_id)
    return {
        "ok": True,
        "voice_id": voice_id,
        "installed": True,
        "model_path": str(model_target),
        "config_path": str(config_target),
    }


def install_voice_from_url(
    voice_id: str,
    model_url: str,
    *,
    config_url: str = "",
    label: str = "",
    description: str = "",
    language: str = "",
    quality: str = "",
    gender: str = "",
) -> dict[str, object]:
    """Download and register one custom Piper voice from direct URLs."""
    normalized_voice_id = str(voice_id).strip()
    normalized_url = str(model_url).strip()
    normalized_config_url = str(config_url).strip()
    if not normalized_voice_id:
        raise RuntimeError("Custom Piper voice id is required.")
    if not normalized_url.endswith(".onnx"):
        raise RuntimeError("Custom Piper voice URL must point to a .onnx model file.")
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    model_target = model_path(normalized_voice_id)
    config_target = config_path(normalized_voice_id)
    urllib.request.urlretrieve(normalized_url, model_target)
    effective_config_url = normalized_config_url or f"{normalized_url}.json"
    urllib.request.urlretrieve(effective_config_url, config_target)
    _save_custom_voice_registry(
        [
            *[entry for entry in _load_custom_voice_registry() if str(entry.get("id")) != normalized_voice_id],
            {
                "id": normalized_voice_id,
                "label": label.strip() or normalized_voice_id,
                "language": language.strip() or "custom",
                "quality": quality.strip() or "custom",
                "description": description.strip() or "Custom Piper voice.",
                "base_url": "",
                "source_url": normalized_url,
                "config_url": effective_config_url,
                "gender": gender.strip(),
                "custom": True,
            },
        ]
    )
    _VOICE_CACHE.pop(normalized_voice_id, None)
    warm_voice(normalized_voice_id)
    return {
        "ok": True,
        "voice_id": normalized_voice_id,
        "installed": True,
        "model_path": str(model_target),
        "config_path": str(config_target),
        "source_url": normalized_url,
        "config_url": effective_config_url,
    }


def install_voice_from_upload(
    voice_id: str,
    model_data_url: str,
    config_data_url: str,
    *,
    label: str = "",
    description: str = "",
    model_source_name: str = "",
    config_source_name: str = "",
    language: str = "",
    quality: str = "",
    gender: str = "",
) -> dict[str, object]:
    """Persist and register one custom Piper voice from uploaded files."""
    normalized_voice_id = str(voice_id).strip()
    if not normalized_voice_id:
        raise RuntimeError("Custom Piper voice id is required.")
    model_bytes = _decode_data_url(model_data_url)
    config_bytes = _decode_data_url(config_data_url)
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    model_target = model_path(normalized_voice_id)
    config_target = config_path(normalized_voice_id)
    model_target.write_bytes(model_bytes)
    config_target.write_bytes(config_bytes)
    _save_custom_voice_registry(
        [
            *[entry for entry in _load_custom_voice_registry() if str(entry.get("id")) != normalized_voice_id],
            {
                "id": normalized_voice_id,
                "label": label.strip() or normalized_voice_id,
                "language": language.strip() or "custom",
                "quality": quality.strip() or "custom",
                "description": description.strip() or "Custom Piper voice.",
                "base_url": "",
                "source_url": "",
                "config_url": "",
                "model_source_name": str(model_source_name).strip(),
                "config_source_name": str(config_source_name).strip(),
                "gender": gender.strip(),
                "custom": True,
            },
        ]
    )
    _VOICE_CACHE.pop(normalized_voice_id, None)
    warm_voice(normalized_voice_id)
    return {
        "ok": True,
        "voice_id": normalized_voice_id,
        "installed": True,
        "model_path": str(model_target),
        "config_path": str(config_target),
        "model_source_name": str(model_source_name).strip(),
        "config_source_name": str(config_source_name).strip(),
    }


def reinstall_voice(voice_id: str) -> dict[str, object]:
    """Reinstall one curated or custom Piper voice from its saved source."""
    voice = _catalog_voice(voice_id)
    model_path(voice_id).unlink(missing_ok=True)
    config_path(voice_id).unlink(missing_ok=True)
    _VOICE_CACHE.pop(voice_id, None)
    source_url = str(voice.get("source_url") or "").strip()
    config_url = str(voice.get("config_url") or "").strip()
    if source_url:
        return install_voice_from_url(
            voice_id,
            source_url,
            config_url=config_url,
            label=str(voice.get("label") or voice_id),
            description=str(voice.get("description") or ""),
        )
    if bool(voice.get("custom")):
        raise RuntimeError("This custom voice was added from local files and cannot be re-downloaded automatically.")
    return install_voice(voice_id)


def remove_voice(voice_id: str) -> dict[str, object]:
    """Remove one installed custom Piper voice from local storage."""
    voice = _catalog_voice(voice_id)
    if not bool(voice.get("custom")):
        raise RuntimeError("Built-in Piper voices cannot be removed from the catalog.")
    model_path(voice_id).unlink(missing_ok=True)
    config_path(voice_id).unlink(missing_ok=True)
    _VOICE_CACHE.pop(voice_id, None)
    _save_custom_voice_registry(
        [entry for entry in _load_custom_voice_registry() if str(entry.get("id")) != voice_id]
    )
    return {"ok": True, "voice_id": voice_id, "removed": True}


def update_custom_voice(
    voice_id: str,
    *,
    label: str,
    description: str,
    model_url: str,
    config_url: str,
    language: str,
    quality: str,
    gender: str,
) -> dict[str, object]:
    """Update stored metadata for one custom Piper voice."""
    normalized_voice_id = str(voice_id).strip()
    entries = _load_custom_voice_registry()
    updated = False
    next_entries: list[dict[str, object]] = []
    for entry in entries:
        if str(entry.get("id")) != normalized_voice_id:
            next_entries.append(entry)
            continue
        if model_url.strip() and not model_url.strip().endswith(".onnx"):
            raise RuntimeError("Custom Piper voice URL must point to a .onnx model file.")
        next_entry = dict(entry)
        next_entry["label"] = label.strip() or normalized_voice_id
        next_entry["description"] = description.strip() or "Custom Piper voice."
        next_entry["language"] = language.strip() or "custom"
        next_entry["quality"] = quality.strip() or "custom"
        next_entry["gender"] = gender.strip()
        next_entry["source_url"] = model_url.strip()
        next_entry["config_url"] = config_url.strip()
        next_entries.append(next_entry)
        updated = True
    if not updated:
        raise RuntimeError(f"Custom Piper voice '{normalized_voice_id}' was not found.")
    _save_custom_voice_registry(next_entries)
    return {"ok": True, "voice_id": normalized_voice_id, "updated": True}


def synthesize(text: str, voice_id: str) -> bytes:
    """Render speech with Piper and return a full WAV payload (Legacy)."""
    binary = piper_binary_path()
    if binary is None:
        raise RuntimeError("Piper is not installed.")
    if voice_id not in installed_voice_ids():
        raise RuntimeError(f"Piper voice '{voice_id}' is not installed.")
    try:
        # Try in-process first for speed
        import numpy as np
        voice = _cached_voice(voice_id)
        audio_chunks = list(voice.synthesize(text))
        if not audio_chunks:
            return b""
        sample_rate = int(audio_chunks[0].sample_rate)
        merged = np.concatenate([np.asarray(c.audio_float_array, dtype=np.float32).reshape(-1) for c in audio_chunks])
        audio = np.clip(merged * 32767.0, -32768.0, 32767.0).astype(np.int16)
        
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            output_path = Path(handle.name)
        try:
            with wave.open(str(output_path), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(audio.tobytes())
            return output_path.read_bytes()
        finally:
            output_path.unlink(missing_ok=True)
    except Exception as exc:
        raise RuntimeError(f"Piper synthesis failed: {exc}")


def synthesize_stream(text: str, voice_id: str):
    """Generator yielding {pcm, phonemes, meta} for sentence-level streaming."""
    try:
        voice = _cached_voice(voice_id)
        for chunk in voice.synthesize(text, include_alignments=True):
            # Calculate heuristic samples-per-phoneme for the scheduler
            total_samples = len(chunk.audio_float_array)
            phoneme_count = len(chunk.phonemes) if chunk.phonemes else 0
            samples_per_phoneme = total_samples // phoneme_count if phoneme_count > 0 else 0
            
            yield {
                "audio_pcm": chunk.audio_int16_bytes, 
                "sample_rate": chunk.sample_rate,
                "phonemes": chunk.phonemes,
                "samples_per_phoneme": samples_per_phoneme
            }
    except Exception as exc:
        raise RuntimeError(f"Piper streaming synthesis failed: {exc}")


def warm_voice(voice_id: str) -> dict[str, object]:
    """Preload one Piper voice into the app process when possible."""
    if voice_id not in installed_voice_ids():
        raise RuntimeError(f"Piper voice '{voice_id}' is not installed.")
    try:
        _cached_voice(voice_id)
        return {"ok": True, "voice_id": voice_id, "warmed": True, "mode": "python"}
    except Exception:
        return {"ok": True, "voice_id": voice_id, "warmed": False, "mode": "cli"}


def model_path(voice_id: str) -> Path:
    """Return the local ONNX path for one voice."""
    return VOICE_DIR / f"{voice_id}.onnx"


def config_path(voice_id: str) -> Path:
    """Return the local Piper config path for one voice."""
    return VOICE_DIR / f"{voice_id}.onnx.json"


def _catalog_voice(voice_id: str) -> dict[str, object]:
    for voice in _voice_catalog_entries():
        if voice["id"] == voice_id:
            return voice
    raise RuntimeError(f"Unknown Piper voice '{voice_id}'.")


def _voice_catalog_entries() -> list[dict[str, object]]:
    upstream = _load_cached_or_remote_catalog()
    custom_entries = _load_custom_voice_registry()
    custom_ids = {str(entry.get("id")) for entry in custom_entries}
    return [*[
        entry for entry in upstream
        if str(entry.get("id")) not in custom_ids
    ], *custom_entries]


def refresh_upstream_voice_catalog() -> dict[str, object]:
    """Force-refresh the upstream Piper catalog cache and return its status."""
    _upstream_catalog_payload(force_refresh=True)
    return voice_catalog_status()


def _load_cached_or_remote_catalog() -> list[dict[str, object]]:
    payload = _upstream_catalog_payload()
    voices = payload.get("voices")
    if isinstance(voices, list) and voices:
        return [dict(item) for item in voices if isinstance(item, dict)]
    return _fallback_curated_catalog()


def _upstream_catalog_payload(*, force_refresh: bool = False) -> dict[str, object]:
    cached = _read_upstream_catalog_cache()
    cached_fetched_at = float(cached.get("fetched_at") or 0.0)
    cache_is_fresh = cached_fetched_at > 0 and (time.time() - cached_fetched_at) < UPSTREAM_CATALOG_TTL_SECONDS
    if cached and not force_refresh and cache_is_fresh:
        return {
            **cached,
            "used_cache": True,
            "stale": False,
        }
    try:
        with urllib.request.urlopen(UPSTREAM_VOICE_CATALOG_URL, timeout=20) as response:
            payload = json.load(response)
        parsed_voices = _parse_upstream_catalog(payload)
        persisted = {
            "fetched_at": time.time(),
            "voices": parsed_voices,
        }
        _write_upstream_catalog_cache(persisted)
        return {
            **persisted,
            "used_cache": False,
            "stale": False,
        }
    except (URLError, TimeoutError, json.JSONDecodeError, RuntimeError):
        if cached:
            return {
                **cached,
                "used_cache": True,
                "stale": True,
            }
        fallback = {
            "fetched_at": 0.0,
            "voices": _fallback_curated_catalog(),
        }
        return {
            **fallback,
            "used_cache": True,
            "stale": True,
        }


def _parse_upstream_catalog(payload: object) -> list[dict[str, object]]:
    if not isinstance(payload, dict):
        raise RuntimeError("Unexpected Piper voices.json payload shape.")
    voices: list[dict[str, object]] = []
    for voice_id, raw_voice in payload.items():
        if not isinstance(raw_voice, dict):
            continue
        files = raw_voice.get("files")
        if not isinstance(files, dict):
            continue
        model_relative_path = next(
            (
                str(path)
                for path in files
                if str(path).endswith(f"{voice_id}.onnx")
            ),
            "",
        )
        config_relative_path = next(
            (
                str(path)
                for path in files
                if str(path).endswith(f"{voice_id}.onnx.json")
            ),
            "",
        )
        if not model_relative_path or not config_relative_path:
            continue
        curated_meta = CURATED_VOICE_IDS.get(str(voice_id), {})
        name = str(raw_voice.get("name") or voice_id).replace("_", " ").strip()
        language = raw_voice.get("language") if isinstance(raw_voice.get("language"), dict) else {}
        native_language = str(language.get("name_english") or language.get("name_native") or language.get("code") or "")
        region = str(language.get("country_english") or language.get("region") or "")
        voices.append(
            {
                "id": str(voice_id),
                "label": str(curated_meta.get("label") or name.title()),
                "language": str(language.get("code") or ""),
                "quality": str(raw_voice.get("quality") or ""),
                "description": str(curated_meta.get("description") or _voice_description(native_language, region, raw_voice)),
                "gender": str(curated_meta.get("gender") or ""),
                "model_url": f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{model_relative_path}",
                "config_url": f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{config_relative_path}",
                "base_url": "",
                "curated": str(voice_id) in CURATED_VOICE_IDS,
            }
        )
    voices.sort(key=lambda item: (not bool(item.get("curated")), str(item.get("label") or "").lower()))
    return voices


def _voice_description(language_name: str, region_name: str, raw_voice: dict[str, object]) -> str:
    quality = str(raw_voice.get("quality") or "").replace("_", "-")
    speaker_count = int(raw_voice.get("num_speakers") or 1)
    parts = [part for part in [language_name, region_name] if part]
    language_label = " ".join(parts).strip()
    description = f"{quality.title()} Piper voice" if quality else "Piper voice"
    if language_label:
        description = f"{description} for {language_label}"
    if speaker_count > 1:
        description = f"{description} with {speaker_count} speakers"
    return f"{description}."


def _fallback_curated_catalog() -> list[dict[str, object]]:
    return [
        {
            "id": voice_id,
            "label": str(meta["label"]),
            "language": "en_US",
            "quality": "medium",
            "description": str(meta["description"]),
            "gender": str(meta.get("gender") or ""),
            "model_url": f"{_legacy_curated_base_url(voice_id)}/{voice_id}.onnx",
            "config_url": f"{_legacy_curated_base_url(voice_id)}/{voice_id}.onnx.json",
            "base_url": _legacy_curated_base_url(voice_id),
            "curated": True,
        }
        for voice_id, meta in CURATED_VOICE_IDS.items()
    ]


def _legacy_curated_base_url(voice_id: str) -> str:
    language_code, speaker_name, quality = voice_id.split("-", 2)
    family = language_code.split("_", 1)[0]
    return f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{family}/{language_code}/{speaker_name}/{quality}"


def _read_upstream_catalog_cache() -> dict[str, object]:
    if not UPSTREAM_VOICE_CATALOG_PATH.exists():
        return {}
    try:
        payload = json.loads(UPSTREAM_VOICE_CATALOG_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_upstream_catalog_cache(payload: dict[str, object]) -> None:
    UPSTREAM_VOICE_CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPSTREAM_VOICE_CATALOG_PATH.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf-8")


def _load_custom_voice_registry() -> list[dict[str, object]]:
    if not CUSTOM_VOICE_REGISTRY_PATH.exists():
        return []
    try:
        payload = json.loads(CUSTOM_VOICE_REGISTRY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list):
        return []
    return [dict(item) for item in payload if isinstance(item, dict)]


def _save_custom_voice_registry(entries: list[dict[str, object]]) -> None:
    CUSTOM_VOICE_REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    CUSTOM_VOICE_REGISTRY_PATH.write_text(f"{json.dumps(entries, indent=2)}\n", encoding="utf-8")


def _decode_data_url(data_url: str) -> bytes:
    payload = str(data_url or "").strip()
    if "," not in payload:
        raise RuntimeError("Uploaded voice file payload is invalid.")
    import base64

    _, encoded = payload.split(",", 1)
    try:
        return base64.b64decode(encoded)
    except Exception as exc:
        raise RuntimeError("Uploaded voice file could not be decoded.") from exc


def _synthesize_with_cached_voice(text: str, voice_id: str) -> bytes:
    try:
        import numpy as np
    except Exception as exc:
        raise RuntimeError("numpy is required for Piper's in-process fallback.") from exc
    voice = _cached_voice(voice_id)
    audio_chunks = list(voice.synthesize(text))
    if not audio_chunks:
        raise RuntimeError("Piper produced no audio chunks.")
    sample_rate = int(audio_chunks[0].sample_rate)
    merged = np.concatenate(
        [np.asarray(chunk.audio_float_array, dtype=np.float32).reshape(-1) for chunk in audio_chunks]
    )
    merged = np.nan_to_num(merged, nan=0.0, posinf=0.0, neginf=0.0)
    audio = np.clip(merged * 32767.0, -32768.0, 32767.0).astype(np.int16)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        output_path = Path(handle.name)
    try:
        with wave.open(str(output_path), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio.tobytes())
        return output_path.read_bytes()
    finally:
        output_path.unlink(missing_ok=True)


def _cached_voice(voice_id: str) -> Any:
    if voice_id in _VOICE_CACHE:
        return _VOICE_CACHE[voice_id]
    try:
        os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")
        from piper.voice import PiperVoice
    except Exception as exc:
        raise RuntimeError("piper-tts Python runtime is unavailable.") from exc
    with _VOICE_CACHE_LOCK:
        if voice_id not in _VOICE_CACHE:
            with _suppress_stderr():
                _VOICE_CACHE[voice_id] = PiperVoice.load(model_path(voice_id))
        return _VOICE_CACHE[voice_id]


@contextlib.contextmanager
def _suppress_stderr() -> Any:
    """Silence native-library stderr noise during in-process Piper model loading."""
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
