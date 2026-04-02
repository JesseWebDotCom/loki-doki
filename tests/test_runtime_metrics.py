"""Tests for admin runtime metrics helpers."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.runtime_metrics import runtime_metrics_payload


class RuntimeMetricsTests(unittest.TestCase):
    """Verify runtime metrics payload structure."""

    @patch("app.runtime_metrics._cpu_load_percent", return_value=37.5)
    @patch("app.runtime_metrics._total_memory_bytes", return_value=16 * 1024 * 1024)
    @patch("app.runtime_metrics._used_memory_bytes", return_value=8 * 1024 * 1024)
    @patch(
        "app.runtime_metrics._tracked_processes",
        return_value=[
            {
                "label": "LokiDoki App",
                "kind": "app",
                "running": True,
                "pid": 123,
                "cpu_percent": 12.3,
                "memory_bytes": 456,
                "command": "python run.py",
            }
        ],
    )
    @patch(
        "app.runtime_metrics._storage_buckets",
        return_value=[
            {
                "key": "ollama_models",
                "label": "Ollama Models",
                "path": "/tmp/models",
                "exists": True,
                "size_bytes": 1024,
            }
        ],
    )
    @patch(
        "app.runtime_metrics._resource_groups",
        return_value=[
            {
                "key": "system",
                "label": "System",
                "cpu_percent": 37.5,
                "memory_percent": 50.0,
                "memory_used_bytes": 1,
                "memory_total_bytes": 2,
                "disk_percent": 10.0,
                "disk_used_bytes": 3,
                "disk_total_bytes": 4,
                "detail": "detail",
            }
        ],
    )
    def test_runtime_metrics_payload_includes_system_and_processes(
        self,
        _mock_resources,
        _mock_storage,
        _mock_processes,
        _mock_used_memory,
        _mock_total_memory,
        _mock_cpu,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            payload = runtime_metrics_payload(Path(tmpdir), "mac")

        self.assertEqual(payload["system"]["cpu"]["load_percent"], 37.5)
        self.assertEqual(payload["system"]["memory"]["used_percent"], 50.0)
        self.assertIn("disk", payload["system"])
        self.assertEqual(payload["processes"][0]["label"], "LokiDoki App")
        self.assertEqual(payload["storage"][0]["label"], "Ollama Models")
        self.assertEqual(payload["resources"][0]["label"], "System")


if __name__ == "__main__":
    unittest.main()
