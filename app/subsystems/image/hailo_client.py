"""HailoRT client helpers for vision-capable providers."""

from __future__ import annotations

import base64
from io import BytesIO

from app.providers.hailo import exclusive_hailo_device, hailo_device_busy, resolve_vision_hef_path, shared_vdevice
from app.providers.types import ProviderSpec
from app.subsystems.image.response import clean_image_reply
from app.subsystems.text.client import ProviderRequestError


def analyze_hailo_image_completion(
    provider: ProviderSpec,
    prompt: str,
    image_base64: str,
) -> str:
    """Run one image-analysis request against the local Hailo vision runtime."""
    hef_path = resolve_vision_hef_path(provider.model)
    if hef_path is None:
        raise ProviderRequestError(f"Hailo vision HEF '{provider.model}' is not available.")
    try:
        import numpy as np
        from PIL import Image
        from hailo_platform.genai import VLM
    except ImportError as exc:
        raise ProviderRequestError(f"Hailo vision dependencies are unavailable: {exc}") from exc
    try:
        raw_image = base64.b64decode(image_base64, validate=True)
        with Image.open(BytesIO(raw_image)) as decoded_image:
            image = decoded_image.convert("RGB")
        response = _run_hailo_vision_request(hef_path, prompt, image, VLM)
    except ProviderRequestError:
        raise
    except Exception as exc:
        raise ProviderRequestError(f"Hailo vision request failed: {exc}") from exc
    content = clean_image_reply(str(response))
    if not content:
        raise ProviderRequestError("Hailo vision returned an empty response.")
    return content


def _prepare_frame(image, vlm):
    """Resize and cast the uploaded image to the HEF input tensor format."""
    import numpy as np

    height, width = _frame_size(tuple(vlm.input_frame_shape()))
    dtype = vlm.input_frame_format_type()
    resized = image.resize((width, height))
    return np.array(resized, dtype=dtype, copy=True)


def _run_hailo_vision_request(hef_path, prompt: str, image, vlm_class):
    """Execute one Hailo VLM request, retrying once with exclusive device access."""
    try:
        return _generate_with_hailo(hef_path, prompt, image, vlm_class)
    except Exception as exc:
        if not hailo_device_busy(str(exc)):
            raise
    with exclusive_hailo_device():
        return _generate_with_hailo(hef_path, prompt, image, vlm_class)


def _generate_with_hailo(hef_path, prompt: str, image, vlm_class):
    """Run the actual Hailo VLM generation call."""
    with shared_vdevice() as vdevice:
        with vlm_class(vdevice, str(hef_path), optimize_memory_on_device=False) as vlm:
            frame = _prepare_frame(image, vlm)
            return vlm.generate_all(
                [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image"},
                        ],
                    }
                ],
                frames=[frame],
                max_generated_tokens=128,
                do_sample=False,
                timeout_ms=300000,
            )


def _frame_size(shape: tuple[int, ...]) -> tuple[int, int]:
    """Return image height and width from the VLM frame shape."""
    if len(shape) < 2:
        raise ProviderRequestError(f"Unexpected Hailo frame shape: {shape}")
    return int(shape[0]), int(shape[1])
