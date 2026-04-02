"""Tests for profile-driven provider selection."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from app.config import get_profile_defaults
from app.providers.registry import resolve_providers


class ProviderRegistryTests(unittest.TestCase):
    """Verify profile switching changes LLM provider routing."""

    @patch(
        "app.providers.registry.detect_hardware",
        return_value={
            "device_present": True,
            "runtime_cli_present": True,
            "hailo_ollama_port_open": True,
            "hailo_platform_importable": True,
            "hef_files": ["Qwen2-VL-2B-Instruct.hef"],
        },
    )
    @patch("app.providers.registry.probe_hailo_vision", return_value={"ok": True, "detail": "ready"})
    @patch("app.providers.registry.ensure_hailo_llm", return_value={"ok": True, "detail": "ready"})
    def test_profile_switch_changes_llm_provider(
        self,
        _mock_hailo_llm,
        _mock_probe_hailo_vision,
        _mock_detect_hardware,
    ) -> None:
        mac_providers = resolve_providers("mac", get_profile_defaults("mac"))
        hailo_providers = resolve_providers("pi_hailo", get_profile_defaults("pi_hailo"))

        self.assertEqual(mac_providers["llm_fast"].backend, "ollama")
        self.assertEqual(mac_providers["object_detector"].backend, "cpu_detector")
        self.assertEqual(mac_providers["object_detector"].model, "yolo11s")
        self.assertEqual(mac_providers["face_detector"].backend, "onnx_face_detector")
        self.assertEqual(mac_providers["face_detector"].model, "yolov5s_personface.onnx")
        self.assertEqual(mac_providers["face_recognition"].backend, "insightface")
        self.assertEqual(mac_providers["face_recognition"].model, "buffalo_sc")
        self.assertEqual(hailo_providers["llm_fast"].backend, "hailo_ollama")
        self.assertEqual(hailo_providers["llm_fast"].acceleration, "hailo")
        self.assertEqual(hailo_providers["object_detector"].backend, "hailort")
        self.assertEqual(hailo_providers["object_detector"].model, "yolov8m_h10.hef")
        self.assertEqual(hailo_providers["face_detector"].backend, "hailort")
        self.assertEqual(hailo_providers["face_detector"].model, "yolov5s_personface.hef")
        self.assertEqual(hailo_providers["face_recognition"].acceleration, "cpu")

    @patch(
        "app.providers.registry.detect_hardware",
        return_value={
            "device_present": True,
            "runtime_cli_present": True,
            "hailo_ollama_port_open": True,
            "hailo_platform_importable": True,
            "hef_files": ["Qwen2-VL-2B-Instruct.hef"],
        },
    )
    @patch("app.providers.registry.ensure_hailo_llm", return_value={"ok": True, "detail": "ready"})
    def test_pi_hailo_vision_provider_keeps_cpu_fallback_model(self, _mock_hailo_llm, _mock_detect_hardware) -> None:
        with patch(
            "app.providers.registry.probe_hailo_vision",
            side_effect=[
                {"ok": True, "detail": "ready"},
                {"ok": False, "detail": "missing detector hef"},
                {"ok": False, "detail": "missing face hef"},
            ],
        ):
            providers = resolve_providers("pi_hailo", get_profile_defaults("pi_hailo"))

        self.assertEqual(providers["vision"].backend, "hailort")
        self.assertEqual(providers["vision"].fallback_backend, "ollama")
        self.assertEqual(providers["vision"].fallback_model, "moondream:latest")
        self.assertEqual(providers["object_detector"].backend, "cpu_detector")
        self.assertEqual(providers["object_detector"].model, "yolo11n")
        self.assertEqual(providers["object_detector"].fallback_backend, "cpu_detector")
        self.assertEqual(providers["object_detector"].fallback_model, "yolo11n")
        self.assertEqual(providers["face_detector"].backend, "cpu_face_detector")
        self.assertEqual(providers["face_detector"].model, "scrfd_500m")
        self.assertEqual(providers["face_detector"].fallback_backend, "cpu_face_detector")
        self.assertEqual(providers["face_detector"].fallback_model, "scrfd_500m")

    @patch(
        "app.providers.hailo.detect_hardware",
        return_value={
            "device_present": True,
            "runtime_cli_present": True,
            "hailo_platform_importable": True,
            "hef_dir": "/tmp/hefs",
            "hef_files": ["Qwen2-VL-2B-Instruct.v5.1.1.hef"],
        },
    )
    @patch(
        "app.providers.hailo.resolve_vision_hef_path",
        return_value=__import__("pathlib").Path("/tmp/hefs/Qwen2-VL-2B-Instruct.v5.1.1.hef"),
    )
    def test_probe_hailo_vision_accepts_versioned_hef_names(
        self,
        _mock_resolve_hef,
        _mock_detect_hardware,
    ) -> None:
        from app.providers.hailo import probe_hailo_vision

        probe = probe_hailo_vision("Qwen2-VL-2B-Instruct.hef")

        self.assertTrue(probe["ok"])

    @patch(
        "app.providers.hailo.HAILO_SYSTEM_MODELS_DIR",
        new=Path("/tmp/hailo-models"),
    )
    def test_resolve_vision_hef_path_uses_system_model_store(self) -> None:
        from app.providers.hailo import resolve_vision_hef_path

        with patch.object(Path, "exists", autospec=True) as mock_exists:
            def exists_side_effect(path: Path) -> bool:
                return str(path) == "/tmp/hailo-models/yolov8m_h10.hef"

            mock_exists.side_effect = exists_side_effect

            resolved = resolve_vision_hef_path("yolov8m_h10.hef")

        self.assertEqual(resolved, Path("/tmp/hailo-models/yolov8m_h10.hef"))

    @patch(
        "app.providers.hailo.HAILO_SYSTEM_MODELS_DIR",
        new=Path("/tmp/hailo-models"),
    )
    def test_resolve_vision_hef_path_uses_packaged_alias_for_object_detector(self) -> None:
        from app.providers.hailo import resolve_vision_hef_path

        with patch.object(Path, "exists", autospec=True) as mock_exists:
            def exists_side_effect(path: Path) -> bool:
                return str(path) == "/tmp/hailo-models/yolov11m_h10.hef"

            mock_exists.side_effect = exists_side_effect

            resolved = resolve_vision_hef_path("yolov11s.hef")

        self.assertEqual(resolved, Path("/tmp/hailo-models/yolov11m_h10.hef"))

    @patch(
        "app.providers.hailo.detect_hardware",
        return_value={
            "device_present": True,
            "runtime_cli_present": True,
            "hailo_platform_importable": True,
            "hef_dir": "/tmp/hefs",
            "hef_files": ["yolov11s.v5.2.0.hef"],
        },
    )
    @patch(
        "app.providers.hailo.resolve_vision_hef_path",
        return_value=Path("/tmp/hefs/yolov11s.v5.2.0.hef"),
    )
    @patch("app.providers.hailo.detect_hailort_version", return_value="5.1.1")
    def test_probe_hailo_vision_rejects_runtime_version_mismatch(
        self,
        _mock_runtime_version,
        _mock_resolve_hef,
        _mock_detect_hardware,
    ) -> None:
        from app.providers.hailo import probe_hailo_vision

        probe = probe_hailo_vision("yolov11s.hef")

        self.assertFalse(probe["ok"])
        self.assertIn("targets HailoRT 5.2.0", probe["detail"])
        self.assertIn("installed runtime is 5.1.1", probe["detail"])

    @patch(
        "app.providers.hailo.detect_hardware",
        return_value={
            "device_present": True,
            "runtime_cli_present": True,
            "hailo_platform_importable": True,
            "hef_dir": "/tmp/hefs",
            "system_hef_dir": "/usr/share/hailo-models",
            "hef_files": [],
            "system_hef_files": ["scrfd_2.5g_h8l.hef"],
        },
    )
    @patch(
        "app.providers.hailo.resolve_vision_hef_path",
        return_value=Path("/usr/share/hailo-models/scrfd_2.5g_h8l.hef"),
    )
    def test_probe_hailo_vision_rejects_packaged_h8_face_model_on_h10(
        self,
        _mock_resolve_hef,
        _mock_detect_hardware,
    ) -> None:
        from app.providers.hailo import probe_hailo_vision

        probe = probe_hailo_vision("scrfd_10g.hef")

        self.assertFalse(probe["ok"])
        self.assertEqual(probe["resolved_model"], "scrfd_2.5g_h8l.hef")
        self.assertIn("Hailo-8/Hailo-8L", probe["detail"])

    @patch(
        "app.providers.registry.detect_hardware",
        return_value={
            "device_present": True,
            "runtime_cli_present": True,
            "hailo_ollama_port_open": True,
            "hailo_platform_importable": True,
            "hef_files": ["Qwen2-VL-2B-Instruct.v5.1.1.hef", "yolov8m_h10.v5.2.0.hef", "yolov5s_personface.v5.2.0.hef"],
        },
    )
    @patch("app.providers.registry.ensure_hailo_llm", return_value={"ok": True, "detail": "ready"})
    def test_pi_hailo_detector_version_mismatch_falls_back_to_cpu(
        self,
        _mock_hailo_llm,
        _mock_detect_hardware,
    ) -> None:
        with patch(
            "app.providers.registry.probe_hailo_vision",
            side_effect=[
                {"ok": True, "detail": "vision hef ready"},
                {"ok": False, "detail": "HEF 'yolov8m_h10.v5.2.0.hef' targets HailoRT 5.2.0, but the installed runtime is 5.1.1."},
                {"ok": False, "detail": "HEF 'yolov5s_personface.v5.2.0.hef' targets HailoRT 5.2.0, but the installed runtime is 5.1.1."},
            ],
        ):
            providers = resolve_providers("pi_hailo", get_profile_defaults("pi_hailo"))

        self.assertEqual(providers["vision"].backend, "hailort")
        self.assertEqual(providers["object_detector"].backend, "cpu_detector")
        self.assertEqual(providers["object_detector"].model, "yolo11n")
        self.assertIn("installed runtime is 5.1.1", providers["object_detector"].notes)
        self.assertEqual(providers["face_detector"].backend, "cpu_face_detector")
        self.assertEqual(providers["face_detector"].model, "scrfd_500m")
        self.assertIn("installed runtime is 5.1.1", providers["face_detector"].notes)

    @patch(
        "app.providers.registry.detect_hardware",
        return_value={
            "device_present": True,
            "runtime_cli_present": True,
            "hailo_ollama_port_open": True,
            "hailo_platform_importable": True,
            "hef_files": ["Qwen2-VL-2B-Instruct.v5.1.1.hef"],
            "system_hef_files": ["yolov11m_h10.hef", "yolov5s_personface.hef"],
        },
    )
    @patch("app.providers.registry.ensure_hailo_llm", return_value={"ok": True, "detail": "ready"})
    def test_pi_hailo_uses_packaged_object_hef_and_cpu_face_fallback(
        self,
        _mock_hailo_llm,
        _mock_detect_hardware,
    ) -> None:
        with patch(
            "app.providers.registry.probe_hailo_vision",
            side_effect=[
                {"ok": True, "detail": "vision hef ready", "resolved_model": "Qwen2-VL-2B-Instruct.hef"},
                {"ok": True, "detail": "Using packaged HEF 'yolov11m_h10.hef' for requested 'yolov11s.hef'.", "resolved_model": "yolov11m_h10.hef"},
                {"ok": True, "detail": "HEF 'yolov5s_personface.hef' is present and hailo_platform can be imported.", "resolved_model": "yolov5s_personface.hef"},
            ],
        ):
            providers = resolve_providers("pi_hailo", get_profile_defaults("pi_hailo"))

        self.assertEqual(providers["object_detector"].backend, "hailort")
        self.assertEqual(providers["object_detector"].model, "yolov11m_h10.hef")
        self.assertEqual(providers["face_detector"].backend, "hailort")
        self.assertEqual(providers["face_detector"].model, "yolov5s_personface.hef")

    def test_hailo_device_busy_detects_wrapped_out_of_devices_error(self) -> None:
        from app.providers.hailo import hailo_device_busy

        detail = "Could not create shared Hailo VDevice: libhailort failed with error: 74 (HAILO_OUT_OF_PHYSICAL_DEVICES)"

        self.assertTrue(hailo_device_busy(detail))


if __name__ == "__main__":
    unittest.main()
