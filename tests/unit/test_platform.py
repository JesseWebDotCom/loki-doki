import pytest
from unittest.mock import patch, mock_open
from lokidoki.core.platform import detect_platform, get_model_preset, PLATFORM_MODELS


class TestDetectPlatform:
    @patch("lokidoki.core.platform.platform")
    def test_detect_mac(self, mock_plat):
        mock_plat.system.return_value = "Darwin"
        assert detect_platform() == "mac"

    @patch("lokidoki.core.platform.platform")
    def test_detect_linux_no_pi(self, mock_plat):
        mock_plat.system.return_value = "Linux"
        with patch("builtins.open", side_effect=OSError):
            assert detect_platform() == "linux"

    @patch("lokidoki.core.platform.platform")
    def test_detect_pi5_via_cpuinfo(self, mock_plat):
        mock_plat.system.return_value = "Linux"
        cpuinfo = "Hardware\t: BCM2712\nModel\t: Raspberry Pi 5"
        with patch("builtins.open", mock_open(read_data=cpuinfo)):
            assert detect_platform() == "pi5"

    @patch("lokidoki.core.platform.platform")
    def test_detect_pi4_via_cpuinfo(self, mock_plat):
        mock_plat.system.return_value = "Linux"
        cpuinfo = "Hardware\t: BCM2711\nModel\t: Raspberry Pi 4"
        with patch("builtins.open", mock_open(read_data=cpuinfo)):
            assert detect_platform() == "pi"

    @patch("lokidoki.core.platform.platform")
    def test_detect_pi5_via_device_tree(self, mock_plat):
        mock_plat.system.return_value = "Linux"
        call_count = 0

        def side_effect(path, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            if "/proc/cpuinfo" in str(path):
                raise OSError("no cpuinfo")
            return mock_open(read_data="Raspberry Pi 5 Model B Rev 1.0\x00")()

        with patch("builtins.open", side_effect=side_effect):
            assert detect_platform() == "pi5"


class TestGetModelPreset:
    def test_pi5_has_separate_thinking_model(self):
        preset = get_model_preset("pi5")
        assert preset["fast_model"] == "gemma4:e4b"
        assert preset["thinking_model"] == "gemma4"

    def test_pi_uses_same_model_for_both(self):
        preset = get_model_preset("pi")
        assert preset["fast_model"] == "gemma4:e2b"
        assert preset["thinking_model"] == "gemma4:e2b"

    def test_mac_has_separate_thinking_model(self):
        preset = get_model_preset("mac")
        assert preset["fast_model"] == "gemma4:e4b"
        assert preset["thinking_model"] == "gemma4"

    def test_unknown_platform_falls_back_to_linux(self):
        preset = get_model_preset("windows")
        assert preset == PLATFORM_MODELS["linux"]

    def test_auto_detect(self):
        preset = get_model_preset()
        assert "fast_model" in preset
        assert "thinking_model" in preset
