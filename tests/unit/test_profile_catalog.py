"""Tests for the per-profile model catalog and profile detection."""
from unittest.mock import patch

import pytest

from lokidoki.core.platform import (
    FACE_RECOGNITION_DEFAULTS,
    HAILO_RUNTIME_REQUIREMENTS,
    PLATFORM_MODELS,
    UnsupportedPlatform,
    detect_profile,
)


EXPECTED_PROFILES = {"mac", "windows", "linux", "pi_cpu", "pi_hailo"}

REQUIRED_KEYS = {
    "llm_engine",
    "llm_fast",
    "llm_thinking",
    "vision_model",
    "object_detector_model",
    "face_detector_model",
    "stt_model",
    "tts_voice",
    "wake_word",
    "image_gen_model",
    "image_gen_lcm_lora",
    "fast_keep_alive",
    "thinking_keep_alive",
}

VALID_ENGINES = {"mlx", "llama_cpp_vulkan", "llama_cpp_cpu", "hailo_ollama"}


class TestPlatformModels:
    def test_profiles_are_exactly_five(self):
        assert set(PLATFORM_MODELS.keys()) == EXPECTED_PROFILES

    def test_every_profile_has_full_catalog(self):
        for profile, cfg in PLATFORM_MODELS.items():
            missing = REQUIRED_KEYS - set(cfg.keys())
            assert not missing, f"{profile} missing {missing}"

    def test_llm_engine_per_profile(self):
        assert PLATFORM_MODELS["mac"]["llm_engine"] == "mlx"
        assert PLATFORM_MODELS["windows"]["llm_engine"] == "llama_cpp_vulkan"
        assert PLATFORM_MODELS["linux"]["llm_engine"] == "llama_cpp_vulkan"
        assert PLATFORM_MODELS["pi_cpu"]["llm_engine"] == "llama_cpp_cpu"
        assert PLATFORM_MODELS["pi_hailo"]["llm_engine"] == "hailo_ollama"

    def test_no_gemma_no_ollama_in_engines(self):
        # Ollama is allowed in hailo_ollama specifically; stock Ollama is not.
        assert "gemma" not in str(PLATFORM_MODELS).lower()
        for cfg in PLATFORM_MODELS.values():
            assert cfg["llm_engine"] in VALID_ENGINES


class TestDetectProfile:
    @patch("lokidoki.core.platform.platform")
    def test_detect_profile_macos_arm64(self, mock_plat):
        mock_plat.system.return_value = "Darwin"
        mock_plat.machine.return_value = "arm64"
        assert detect_profile() == "mac"

    @patch("lokidoki.core.platform.platform")
    def test_detect_profile_macos_intel_raises(self, mock_plat):
        mock_plat.system.return_value = "Darwin"
        mock_plat.machine.return_value = "x86_64"
        with pytest.raises(UnsupportedPlatform):
            detect_profile()

    @patch("lokidoki.core.platform.platform")
    def test_detect_profile_windows(self, mock_plat):
        mock_plat.system.return_value = "Windows"
        assert detect_profile() == "windows"

    @patch("lokidoki.core.platform._is_raspberry_pi_5", return_value=False)
    @patch("lokidoki.core.platform.platform")
    def test_detect_profile_linux_generic(self, mock_plat, _is_pi):
        mock_plat.system.return_value = "Linux"
        assert detect_profile() == "linux"

    @patch("lokidoki.core.platform._has_hailo_runtime", return_value=False)
    @patch("lokidoki.core.platform._is_raspberry_pi_5", return_value=True)
    @patch("lokidoki.core.platform.platform")
    def test_detect_profile_pi_cpu(self, mock_plat, _is_pi, _hailo):
        mock_plat.system.return_value = "Linux"
        assert detect_profile() == "pi_cpu"

    @patch("lokidoki.core.platform._has_hailo_runtime", return_value=True)
    @patch("lokidoki.core.platform._is_raspberry_pi_5", return_value=True)
    @patch("lokidoki.core.platform.platform")
    def test_detect_profile_pi_hailo(self, mock_plat, _is_pi, _hailo):
        mock_plat.system.return_value = "Linux"
        assert detect_profile() == "pi_hailo"


class TestFaceRecognitionDefaults:
    def test_face_recognition_has_all_five_profiles(self):
        assert set(FACE_RECOGNITION_DEFAULTS.keys()) == EXPECTED_PROFILES

    def test_face_recognition_thresholds(self):
        for profile, cfg in FACE_RECOGNITION_DEFAULTS.items():
            assert cfg["recognition_threshold"] == 0.4
            assert cfg["min_face_size_px"] == 80.0
            expected_sharpness = 55.0 if profile.startswith("pi_") else 65.0
            assert cfg["sharpness_threshold"] == expected_sharpness


class TestHailoRequirements:
    def test_hailo_requirements_shape(self):
        reqs = HAILO_RUNTIME_REQUIREMENTS
        assert reqs["device_node"] == "/dev/hailo0"
        assert reqs["cli"].endswith("hailortcli")
        assert reqs["blacklist_line"] == "blacklist hailo_pci"
        assert reqs["hailo_ollama_port"] == 8000
        assert "Qwen2-VL-2B-Instruct.hef" in reqs["hef_files"]
