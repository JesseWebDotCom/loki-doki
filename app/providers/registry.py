"""Profile-driven provider registry."""

from __future__ import annotations

from app.config import get_profile_defaults
from app.providers.hailo import capability_cards, detect_hardware, ensure_hailo_llm, probe_hailo_vision
from app.providers.ollama import probe_provider_endpoint, probe_provider_model
from app.providers.piper_service import piper_status
from app.providers.types import CapabilityStatus, ProviderSpec


def resolve_providers(profile: str, models: dict[str, str]) -> dict[str, ProviderSpec]:
    """Return the provider map for the active profile."""
    use_hailo = profile == "pi_hailo"
    use_mac_onnx_face = profile == "mac"
    stt_backend = "whisper_cpp" if models["stt_model"].startswith("whisper.cpp ") else "faster_whisper"
    hardware = detect_hardware() if use_hailo else {}
    llm_probe = ensure_hailo_llm() if use_hailo else {"ok": False}
    hailo_ready = bool(
        hardware.get("device_present")
        and hardware.get("runtime_cli_present")
        and llm_probe["ok"]
    )
    vision_probe = probe_hailo_vision(models["vision_model"]) if use_hailo else {"ok": False}
    vision_hailo_ready = bool(hardware.get("device_present") and vision_probe["ok"])
    object_probe = probe_hailo_vision(models["object_detector_model"]) if use_hailo else {"ok": False}
    object_hailo_ready = bool(hardware.get("device_present") and object_probe["ok"])
    face_probe = probe_hailo_vision(models["face_detector_model"]) if use_hailo else {"ok": False}
    face_hailo_ready = bool(hardware.get("device_present") and face_probe["ok"])
    llm_backend = "hailo_ollama" if use_hailo and hailo_ready else "ollama"
    vision_backend = "hailort" if use_hailo and vision_hailo_ready else "ollama"
    object_backend = "hailort" if use_hailo and object_hailo_ready else "cpu_detector"
    face_backend = (
        "hailort"
        if use_hailo and face_hailo_ready
        else ("onnx_face_detector" if use_mac_onnx_face else "cpu_face_detector")
    )
    object_model = (
        object_probe.get("resolved_model", models["object_detector_model"])
        if object_backend == "hailort"
        else (
            get_profile_defaults("pi_cpu")["object_detector_model"]
            if use_hailo
            else models["object_detector_model"]
        )
    )
    face_model = (
        face_probe.get("resolved_model", models["face_detector_model"])
        if face_backend == "hailort"
        else (
            get_profile_defaults("pi_cpu")["face_detector_model"]
            if use_hailo
            else models["face_detector_model"]
        )
    )
    if use_hailo:
        llm_notes = (
            "Hailo-backed LLM active."
            if llm_backend == "hailo_ollama"
            else f"CPU fallback active until Hailo runtime is ready. {llm_probe['detail']}"
        )
        vision_notes = (
            "Hailo vision active."
            if vision_backend == "hailort"
            else f"CPU fallback active until Hailo vision prerequisites are present. {vision_probe['detail']}"
        )
        object_notes = (
            "Hailo object detector active."
            if object_backend == "hailort"
            else f"CPU fallback active until the Hailo object detector is compatible. {object_probe['detail']}"
        )
        face_notes = (
            "Hailo face detector active."
            if face_backend == "hailort"
            else f"CPU fallback active until the Hailo face detector is compatible. {face_probe['detail']}"
        )
    else:
        llm_notes = "Profile uses Ollama on CPU by design."
        vision_notes = "Profile uses CPU vision by design."
        object_notes = "Profile uses the CPU object detector by design."
        face_notes = (
            "Profile uses onnxruntime with the CoreML execution provider when available."
            if use_mac_onnx_face
            else "Profile uses the CPU face detector by design."
        )
    return {
        "llm_fast": ProviderSpec(
            name="llm_fast",
            backend=llm_backend,
            model=models["llm_fast"],
            acceleration="hailo" if llm_backend == "hailo_ollama" else "cpu",
            endpoint="http://127.0.0.1:8000" if llm_backend == "hailo_ollama" else "http://127.0.0.1:11434",
            fallback_backend="ollama" if use_hailo else None,
            fallback_model=get_profile_defaults("pi_cpu")["llm_fast"] if use_hailo else None,
            notes=llm_notes,
        ),
        "llm_thinking": ProviderSpec(
            name="llm_thinking",
            backend=llm_backend,
            model=models["llm_thinking"],
            acceleration="hailo" if llm_backend == "hailo_ollama" else "cpu",
            endpoint="http://127.0.0.1:8000" if llm_backend == "hailo_ollama" else "http://127.0.0.1:11434",
            fallback_backend="ollama" if use_hailo else None,
            fallback_model=get_profile_defaults("pi_cpu")["llm_thinking"] if use_hailo else None,
            notes=llm_notes,
        ),
        "function_model": ProviderSpec(
            name="function_model",
            backend="ollama",
            model=models["function_model"],
            acceleration="cpu",
            endpoint="http://127.0.0.1:11434",
            notes="Function model stays on CPU across all profiles.",
        ),
        "vision": ProviderSpec(
            name="vision",
            backend=vision_backend,
            model=models["vision_model"],
            acceleration="hailo" if vision_backend == "hailort" else "cpu",
            endpoint=None if vision_backend == "hailort" else "http://127.0.0.1:11434",
            fallback_backend="ollama" if use_hailo else None,
            fallback_model=get_profile_defaults("pi_cpu")["vision_model"] if use_hailo else None,
            notes=vision_notes,
        ),
        "object_detector": ProviderSpec(
            name="object_detector",
            backend=object_backend,
            model=object_model,
            acceleration="hailo" if object_backend == "hailort" else "cpu",
            fallback_backend="cpu_detector" if use_hailo else None,
            fallback_model=get_profile_defaults("pi_cpu")["object_detector_model"] if use_hailo else None,
            notes=object_notes,
        ),
        "face_detector": ProviderSpec(
            name="face_detector",
            backend=face_backend,
            model=face_model,
            acceleration="hailo" if face_backend == "hailort" else ("coreml" if use_mac_onnx_face else "cpu"),
            fallback_backend="cpu_face_detector" if use_hailo or use_mac_onnx_face else None,
            fallback_model=(
                get_profile_defaults("pi_cpu")["face_detector_model"]
                if use_hailo
                else ("scrfd_10g" if use_mac_onnx_face else None)
            ),
            notes=face_notes,
        ),
        "face_recognition": ProviderSpec(
            name="face_recognition",
            backend="insightface",
            model="buffalo_sc",
            acceleration="cpu",
            notes="Face embedding and cosine similarity matching run on CPU across all profiles.",
        ),
        "stt": ProviderSpec(
            name="stt",
            backend=stt_backend,
            model=models["stt_model"],
            acceleration="cpu",
            notes="STT is CPU-only on every profile.",
        ),
        "tts": ProviderSpec(
            name="tts",
            backend="piper",
            model=models["tts_voice"],
            acceleration="cpu",
            notes="TTS is CPU-only on every profile.",
        ),
        "wake_word": ProviderSpec(
            name="wake_word",
            backend="openwakeword",
            model=models["wake_word"],
            acceleration="cpu",
            notes="Wake word is CPU-only on every profile.",
        ),
    }


def capability_summary(profile: str, models: dict[str, str]) -> list[CapabilityStatus]:
    """Return provider and Hailo capability cards for UI health surfaces."""
    providers = resolve_providers(profile, models)
    provider_cards = [
        _provider_status_card(profile, name, spec)
        for name, spec in providers.items()
    ]
    return provider_cards + capability_cards(profile, models)


def _provider_status_card(profile: str, name: str, spec: ProviderSpec) -> CapabilityStatus:
    """Return one provider health card."""
    status = _fallback_status(profile, name, spec)
    detail = f"{spec.backend} / {spec.model} / {spec.acceleration}"
    if spec.endpoint and spec.backend in {"ollama", "hailo_ollama"}:
        probe = probe_provider_endpoint(spec)
        detail = f"{detail} / {probe['detail']}"
        if not probe["ok"]:
            status = _unavailable_status(name)
        elif name in {"llm_fast", "llm_thinking", "function_model", "vision"}:
            model_probe = probe_provider_model(spec)
            detail = f"{detail} / {model_probe['detail']}"
            if not model_probe["ok"]:
                status = _unavailable_status(name)
    elif name == "tts":
        runtime = piper_status(spec.model)
        detail = f"{detail} / {'piper ready' if runtime['binary_ready'] else 'piper binary missing'}"
        if runtime["selected_voice_installed"]:
            detail = f"{detail} / {spec.model} installed."
        else:
            detail = f"{detail} / {spec.model} not installed."
            status = "warn"
    if spec.notes:
        detail = f"{detail} / {spec.notes}"
    return CapabilityStatus(
        key=name,
        label=spec.name.replace("_", " ").title(),
        status=status,
        detail=detail,
    )


def _fallback_status(profile: str, name: str, spec: ProviderSpec) -> str:
    """Return the baseline status before endpoint probes run."""
    if profile == "pi_hailo" and name in {"llm_fast", "llm_thinking", "vision", "object_detector", "face_detector"} and spec.acceleration == "cpu":
        return "warn"
    return "ok"


def _unavailable_status(name: str) -> str:
    """Return status severity when an active provider endpoint is down."""
    if name in {"llm_fast", "llm_thinking"}:
        return "error"
    return "warn"
