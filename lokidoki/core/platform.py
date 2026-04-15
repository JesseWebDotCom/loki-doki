"""Profile detection and per-profile model + engine catalog.

Single source of truth for which LLM engine runs on which platform and
which models that platform uses. Five supported profiles:
``mac`` (Apple Silicon only), ``windows``, ``linux``, ``pi_cpu``, ``pi_hailo``.
"""
import platform
from pathlib import Path
from typing import Literal


Profile = Literal["mac", "windows", "linux", "pi_cpu", "pi_hailo"]


class UnsupportedPlatform(RuntimeError):
    """Raised when the host platform cannot run LokiDoki."""


PLATFORM_MODELS: dict[str, dict] = {
    "mac": {
        "llm_engine": "mlx",
        "llm_fast": "mlx-community/Qwen3-8B-4bit",
        "llm_thinking": "mlx-community/Qwen3-14B-4bit",
        "vision_model": "mlx-community/Qwen2-VL-7B-Instruct-4bit",
        "object_detector_model": "yolo26s",
        "face_detector_model": "scrfd_2.5g.onnx",
        "stt_model": "faster-whisper small.en",
        "tts_voice": "en_US-lessac-high",
        "wake_word": "openWakeWord",
        "image_gen_model": "black-forest-labs/FLUX.1-schnell",
        "image_gen_lcm_lora": None,
        "fast_keep_alive": -1,
        "thinking_keep_alive": "5m",
    },
    "windows": {
        "llm_engine": "llama_cpp_vulkan",
        "llm_fast": "Qwen/Qwen3-8B-GGUF:Q4_K_M",
        "llm_thinking": "Qwen/Qwen3-14B-GGUF:Q4_K_M",
        "vision_model": "Qwen/Qwen2-VL-7B-Instruct-GGUF:Q4_K_M",
        "object_detector_model": "yolo26s",
        "face_detector_model": "scrfd_2.5g.onnx",
        "stt_model": "faster-whisper small.en",
        "tts_voice": "en_US-lessac-high",
        "wake_word": "openWakeWord",
        "image_gen_model": "black-forest-labs/FLUX.1-schnell",
        "image_gen_lcm_lora": None,
        "fast_keep_alive": -1,
        "thinking_keep_alive": "5m",
    },
    "linux": {
        "llm_engine": "llama_cpp_vulkan",
        "llm_fast": "Qwen/Qwen3-8B-GGUF:Q4_K_M",
        "llm_thinking": "Qwen/Qwen3-14B-GGUF:Q4_K_M",
        "vision_model": "Qwen/Qwen2-VL-7B-Instruct-GGUF:Q4_K_M",
        "object_detector_model": "yolo26s",
        "face_detector_model": "scrfd_2.5g.onnx",
        "stt_model": "faster-whisper small.en",
        "tts_voice": "en_US-lessac-high",
        "wake_word": "openWakeWord",
        "image_gen_model": "black-forest-labs/FLUX.1-schnell",
        "image_gen_lcm_lora": None,
        "fast_keep_alive": -1,
        "thinking_keep_alive": "5m",
    },
    "pi_cpu": {
        "llm_engine": "llama_cpp_cpu",
        "llm_fast": "Qwen/Qwen3-4B-Instruct-GGUF:Q4_K_M",
        "llm_thinking": "Qwen/Qwen3-4B-GGUF:Q4_K_M",
        "vision_model": "Qwen/Qwen2-VL-2B-Instruct-GGUF:Q4_K_M",
        "object_detector_model": "yolo26n",
        "face_detector_model": "scrfd_500m.onnx",
        "stt_model": "whisper.cpp base.en",
        "tts_voice": "en_US-lessac-medium",
        "wake_word": "openWakeWord",
        "image_gen_model": "runwayml/stable-diffusion-v1-5",
        "image_gen_lcm_lora": "latent-consistency/lcm-lora-sdv1-5",
        "fast_keep_alive": -1,
        "thinking_keep_alive": "5m",
    },
    "pi_hailo": {
        "llm_engine": "hailo_ollama",
        "llm_fast": "qwen3:1.7b",
        "llm_thinking": "qwen3:4b",
        "vision_model": "Qwen2-VL-2B-Instruct.hef",
        "object_detector_model": "yolov8m.hef",
        "face_detector_model": "yolov5s_personface.hef",
        "stt_model": "whisper.cpp base.en",
        "tts_voice": "en_US-lessac-medium",
        "wake_word": "openWakeWord",
        "image_gen_model": "runwayml/stable-diffusion-v1-5",
        "image_gen_lcm_lora": "latent-consistency/lcm-lora-sdv1-5",
        "fast_keep_alive": -1,
        "thinking_keep_alive": "5m",
    },
}


FACE_RECOGNITION_DEFAULTS: dict[str, dict[str, float]] = {
    "mac": {
        "recognition_threshold": 0.4,
        "min_face_size_px": 80.0,
        "sharpness_threshold": 65.0,
    },
    "windows": {
        "recognition_threshold": 0.4,
        "min_face_size_px": 80.0,
        "sharpness_threshold": 65.0,
    },
    "linux": {
        "recognition_threshold": 0.4,
        "min_face_size_px": 80.0,
        "sharpness_threshold": 65.0,
    },
    "pi_cpu": {
        "recognition_threshold": 0.4,
        "min_face_size_px": 80.0,
        "sharpness_threshold": 55.0,
    },
    "pi_hailo": {
        "recognition_threshold": 0.4,
        "min_face_size_px": 80.0,
        "sharpness_threshold": 55.0,
    },
}


HAILO_RUNTIME_REQUIREMENTS = {
    "device_node": "/dev/hailo0",
    "cli": "/usr/bin/hailortcli",
    "blacklist_file": "/etc/modprobe.d/blacklist-hailo.conf",
    "blacklist_line": "blacklist hailo_pci",
    "hef_files": [
        "yolov8m.hef",
        "yolov5s_personface.hef",
        "Qwen2-VL-2B-Instruct.hef",
    ],
    "hailo_ollama_port": 8000,
}


def _is_raspberry_pi_5() -> bool:
    """True when the running Linux host is a Raspberry Pi 5."""
    for path in ("/proc/device-tree/model", "/proc/cpuinfo"):
        try:
            text = Path(path).read_text(errors="ignore").lower()
        except OSError:
            continue
        if "bcm2712" in text or "raspberry pi 5" in text:
            return True
    return False


def _has_hailo_runtime() -> bool:
    """True when Hailo HAT hardware or CLI is present."""
    reqs = HAILO_RUNTIME_REQUIREMENTS
    return Path(reqs["device_node"]).exists() or Path(reqs["cli"]).exists()


def detect_profile() -> Profile:
    """Return the active profile for the current host.

    Raises ``UnsupportedPlatform`` on Intel Macs — Layer 0 launchers
    catch this and emit a one-line message before exiting.
    """
    system = platform.system()

    if system == "Windows":
        return "windows"

    if system == "Darwin":
        if platform.machine() != "arm64":
            raise UnsupportedPlatform(
                "Intel Macs are not supported. "
                "LokiDoki requires an Apple Silicon (arm64) Mac."
            )
        return "mac"

    if system == "Linux":
        if _is_raspberry_pi_5():
            return "pi_hailo" if _has_hailo_runtime() else "pi_cpu"
        return "linux"

    return "linux"


def get_model_preset(profile: Profile | None = None) -> dict:
    """Return the full model catalog dict for ``profile`` (or the active one)."""
    if profile is None:
        profile = detect_profile()
    return PLATFORM_MODELS[profile]
