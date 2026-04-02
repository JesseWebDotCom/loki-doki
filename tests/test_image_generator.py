import unittest
from unittest.mock import MagicMock, patch

from app.config import AppConfig
from app.subsystems.image.generator import ImageGenerationError, generate_image, _detect_device


class TestImageGenerator(unittest.TestCase):
    def setUp(self) -> None:
        self.config = MagicMock()
        self.profile = "mac"

    @patch("app.subsystems.image.generator._detect_device")
    @patch("app.subsystems.image.generator._ensure_pipelines")
    def test_txt2img_success(
        self, mock_ensure_pipelines: MagicMock, mock_detect_device: MagicMock
    ) -> None:
        mock_detect_device.return_value = "cpu"
        
        mock_txt2img_pipe = MagicMock()
        mock_img2img_pipe = MagicMock()
        mock_ensure_pipelines.return_value = (mock_txt2img_pipe, mock_img2img_pipe)
        
        mock_image = MagicMock()
        mock_txt2img_pipe.return_value.images = [mock_image]
        
        with patch("app.subsystems.image.generator._pil_to_base64_data_uri", return_value="data:image/jpeg;base64,mock"):
            with patch.dict("sys.modules", {"torch": MagicMock()}):
                result = generate_image("a cute cat", self.config, self.profile)
            
        self.assertEqual(result, "data:image/jpeg;base64,mock")
        mock_txt2img_pipe.assert_called_once()
        self.assertEqual(mock_txt2img_pipe.call_args[1]["prompt"], "a cute cat")
        self.assertEqual(mock_txt2img_pipe.call_args[1]["num_inference_steps"], 6)

    @patch("app.subsystems.image.generator._detect_device")
    @patch("app.subsystems.image.generator._ensure_pipelines")
    def test_img2img_success(
        self, mock_ensure_pipelines: MagicMock, mock_detect_device: MagicMock
    ) -> None:
        mock_detect_device.return_value = "cpu"
        
        mock_txt2img_pipe = MagicMock()
        mock_img2img_pipe = MagicMock()
        mock_ensure_pipelines.return_value = (mock_txt2img_pipe, mock_img2img_pipe)
        
        mock_image = MagicMock()
        mock_img2img_pipe.return_value.images = [mock_image]
        
        with patch("app.subsystems.image.generator._base64_to_pil", return_value=MagicMock()):
            with patch("app.subsystems.image.generator._pil_to_base64_data_uri", return_value="data:image/jpeg;base64,mock2"):
                with patch.dict("sys.modules", {"torch": MagicMock()}):
                    result = generate_image("make it nighttime", self.config, self.profile, init_image_url="data:image/jpeg;base64,mock1")
            
        self.assertEqual(result, "data:image/jpeg;base64,mock2")
        mock_img2img_pipe.assert_called_once()
        self.assertEqual(mock_img2img_pipe.call_args[1]["prompt"], "make it nighttime")
        self.assertEqual(mock_img2img_pipe.call_args[1]["num_inference_steps"], 6)

    @patch("app.subsystems.image.generator._ensure_pipelines")
    def test_pipeline_failure_raises_error(self, mock_ensure_pipelines: MagicMock) -> None:
        mock_ensure_pipelines.side_effect = RuntimeError("Mocked import error")
        
        with self.assertRaises(ImageGenerationError) as context:
            generate_image("a cute cat", self.config, self.profile)
            
        self.assertIn("Failed to load image generation model", str(context.exception))
