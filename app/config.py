"""Configuration helpers for LokiDoki."""

from __future__ import annotations

import json
import os
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional convenience dependency
    def load_dotenv() -> bool:
        """Fallback no-op when python-dotenv is unavailable."""
        return False


load_dotenv()  # Load from .env if present


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("LOKIDOKI_DATA_DIR", str(ROOT_DIR / ".lokidoki")))
UI_DIST_DIR = ROOT_DIR / "app" / "ui" / "dist"
BOOTSTRAP_CONFIG_PATH = DATA_DIR / "bootstrap_config.json"
DATABASE_PATH = DATA_DIR / "lokidoki.db"
FACE_REGISTRY_PATH = DATA_DIR / "faces.json"
SKILLS_INSTALLED_DIR = DATA_DIR / "skills" / "installed"
SKILLS_BUILTIN_DIR = ROOT_DIR / "app" / "skills" / "builtins"
SKILLS_REPO_INDEX_PATH = ROOT_DIR / "app" / "skills" / "repository" / "index.json"
SKILLS_REPOSITORY_INDEX_URL = os.environ.get(
    "LOKIDOKI_SKILLS_REPOSITORY_INDEX_URL",
    "https://raw.githubusercontent.com/JesseWebDotCom/loki-doki-skills/main/index.json",
)
CHARACTERS_BUILTIN_DIR = ROOT_DIR / "app" / "characters" / "builtins"
CHARACTERS_REPOSITORY_DIR = ROOT_DIR / "app" / "characters" / "repository"
CHARACTERS_REPOSITORY_INDEX_URL = os.environ.get(
    "LOKIDOKI_CHARACTERS_REPOSITORY_INDEX_URL",
    "https://raw.githubusercontent.com/JesseWebDotCom/loki-doki-characters/main/index.json",
)
APP_HOST = "127.0.0.1"
APP_PORT = 8008
PUBLIC_HOST = "127.0.0.1"
PUBLIC_PORT = 7860
PROFILE_DEFAULTS: dict[str, dict[str, str]] = {
    "mac": {
        "llm_fast": "qwen2.5:7b-instruct-q4_K_M",
        "llm_thinking": "qwen2.5:14b-instruct-q4_K_M",
        "function_model": "gemma3:1b",
        "vision_model": "llava:7b-v1.6-mistral-q4_K_M",
        "object_detector_model": "yolo11s",
        "face_detector_model": "yolov5s_personface.onnx",
        "stt_model": "faster-whisper base.en",
        "tts_voice": "en_US-lessac-medium",
        "wake_word": "openWakeWord",
        "image_gen_model": "runwayml/stable-diffusion-v1-5",
        "image_gen_lcm_lora": "latent-consistency/lcm-lora-sdv1-5",
    },
    "pi_cpu": {
        "llm_fast": "qwen2:1.5b",
        "llm_thinking": "qwen2:1.5b",
        "function_model": "gemma3:1b",
        "vision_model": "moondream:latest",
        "object_detector_model": "yolo11n",
        "face_detector_model": "scrfd_500m",
        "stt_model": "whisper.cpp base.en",
        "tts_voice": "en_US-lessac-medium",
        "wake_word": "openWakeWord",
        "image_gen_model": "runwayml/stable-diffusion-v1-5",
        "image_gen_lcm_lora": "latent-consistency/lcm-lora-sdv1-5",
    },
    "pi_hailo": {
        "llm_fast": "qwen2.5-instruct:1.5b",
        "llm_thinking": "qwen2.5-instruct:1.5b",
        "function_model": "gemma3:1b",
        "vision_model": "Qwen2-VL-2B-Instruct.hef",
        "object_detector_model": "yolov8m_h10.hef",
        "face_detector_model": "yolov5s_personface.hef",
        "stt_model": "whisper.cpp base.en",
        "tts_voice": "en_US-lessac-medium",
        "wake_word": "openWakeWord",
        "image_gen_model": "runwayml/stable-diffusion-v1-5",
        "image_gen_lcm_lora": "latent-consistency/lcm-lora-sdv1-5",
    },
}
FACE_RECOGNITION_DEFAULTS: dict[str, dict[str, float]] = {
    "mac": {
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


@dataclass(frozen=True)
class AppConfig:
    """Typed runtime configuration."""

    root_dir: Path
    data_dir: Path
    bootstrap_config_path: Path
    database_path: Path
    ui_dist_dir: Path
    skills_installed_dir: Path = DATA_DIR / "skills" / "installed"
    skills_builtin_dir: Path = ROOT_DIR / "app" / "skills" / "builtins"
    skills_repo_index_path: Path = (
        ROOT_DIR / "app" / "skills" / "repository" / "index.json"
    )
    skills_repository_index_url: str = SKILLS_REPOSITORY_INDEX_URL
    characters_builtin_dir: Path = ROOT_DIR / "app" / "characters" / "builtins"
    characters_repository_dir: Path = ROOT_DIR / "app" / "characters" / "repository"
    characters_repository_index_url: str = CHARACTERS_REPOSITORY_INDEX_URL
    jwt_secret: str = ""
    app_host: str = APP_HOST
    app_port: int = APP_PORT
    public_host: str = PUBLIC_HOST
    public_port: int = PUBLIC_PORT


def detect_profile() -> str:
    """Detect the active LokiDoki profile for the current machine."""
    system = platform.system().lower()
    machine = platform.machine().lower()
    if "darwin" in system:
        return "mac"
    if "linux" in system and ("arm" in machine or "aarch64" in machine):
        if Path("/dev/hailo0").exists() or Path("/usr/bin/hailortcli").exists():
            return "pi_hailo"
        return "pi_cpu"
    return "mac"


def default_public_bind_host(profile: Optional[str] = None) -> str:
    """Return the bind host for the bootstrap server."""
    active_profile = profile or detect_profile()
    if active_profile in {"pi_cpu", "pi_hailo"}:
        return "0.0.0.0"
    return "127.0.0.1"


def load_bootstrap_config(path: Path = BOOTSTRAP_CONFIG_PATH) -> dict[str, Any]:
    """Load the persisted bootstrap configuration."""
    if not path.exists():
        return {}
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    profile = str(config.get("profile") or detect_profile())
    models = config.get("models")
    if isinstance(models, dict):
        normalized_models = {
            **get_profile_defaults(profile),
            **models,
        }
    else:
        normalized_models = get_profile_defaults(profile)
    if normalized_models.get("tts_voice") == "en_US-cori-medium":
        normalized_models["tts_voice"] = "en_US-lessac-medium"
    config["models"] = normalized_models
    return config


def save_bootstrap_config(
    config: dict[str, Any], path: Path = BOOTSTRAP_CONFIG_PATH
) -> None:
    """Persist bootstrap configuration to disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2), encoding="utf-8")


def get_profile_defaults(profile: str) -> dict[str, str]:
    """Return default model and provider settings for a profile."""
    return dict(PROFILE_DEFAULTS.get(profile, PROFILE_DEFAULTS["mac"]))


def get_face_recognition_defaults(profile: str) -> dict[str, float]:
    """Return face-recognition thresholds for a profile."""
    return dict(
        FACE_RECOGNITION_DEFAULTS.get(profile, FACE_RECOGNITION_DEFAULTS["mac"])
    )


def get_app_config() -> AppConfig:
    """Return the application configuration."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SKILLS_INSTALLED_DIR.mkdir(parents=True, exist_ok=True)
    # Load secrets from environment with secure defaults for local dev
    jwt_secret = os.environ.get("LOKIDOKI_JWT_SECRET", "lokidoki-phase-one-dev-secret")
    return AppConfig(
        root_dir=ROOT_DIR,
        data_dir=DATA_DIR,
        bootstrap_config_path=BOOTSTRAP_CONFIG_PATH,
        database_path=DATABASE_PATH,
        ui_dist_dir=UI_DIST_DIR,
        skills_installed_dir=SKILLS_INSTALLED_DIR,
        skills_builtin_dir=SKILLS_BUILTIN_DIR,
        skills_repo_index_path=SKILLS_REPO_INDEX_PATH,
        skills_repository_index_url=SKILLS_REPOSITORY_INDEX_URL,
        characters_builtin_dir=CHARACTERS_BUILTIN_DIR,
        characters_repository_dir=CHARACTERS_REPOSITORY_DIR,
        characters_repository_index_url=CHARACTERS_REPOSITORY_INDEX_URL,
        jwt_secret=jwt_secret,
    )
