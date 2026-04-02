"""Image generation logic using Diffusers for Phase 4 text-to-image."""

from __future__ import annotations

import base64
import logging
import platform
from io import BytesIO
from typing import Any, Optional, Union

from PIL import Image

from app.config import AppConfig

logger = logging.getLogger(__name__)

# Lazy loaded pipelines
_TXT2IMG_PIPE: Optional[Any] = None
_IMG2IMG_PIPE: Optional[Any] = None


class ImageGenerationError(RuntimeError):
    """Raised when image generation fails."""


def _detect_device() -> str:
    """Return the optimal device string for generation."""
    import platform
    try:
        import torch
        if platform.system() == "Darwin" and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    # Hailo support for raw diffusers is not natively available; fallback to CPU
    return "cpu"


def _ensure_pipelines(config: AppConfig, profile: str) -> tuple[Any, Any]:
    """Load and configure the underlying Diffusers pipelines via LCM LoRA."""
    import torch
    from diffusers import AutoPipelineForImage2Image, AutoPipelineForText2Image, LCMScheduler
    
    global _TXT2IMG_PIPE, _IMG2IMG_PIPE
    if _TXT2IMG_PIPE is not None and _IMG2IMG_PIPE is not None:
        return _TXT2IMG_PIPE, _IMG2IMG_PIPE

    device = _detect_device()
    use_fp16 = device == "mps"
    dtype = torch.float16 if use_fp16 else torch.float32

    logger.info(f"Loading Image Generation pipelines on {device}...")
    
    # Grab model config from defaults
    from app.config import PROFILE_DEFAULTS
    model_id = PROFILE_DEFAULTS.get(profile, PROFILE_DEFAULTS["mac"])["image_gen_model"]
    lora_id = PROFILE_DEFAULTS.get(profile, PROFILE_DEFAULTS["mac"])["image_gen_lcm_lora"]

    # Since we use SD 1.5, we can use safety_checker=None to speed up load and generation
    _TXT2IMG_PIPE = AutoPipelineForText2Image.from_pretrained(
        model_id,
        torch_dtype=dtype,
        safety_checker=None,
        requires_safety_checker=False,
    )
    _TXT2IMG_PIPE.scheduler = LCMScheduler.from_config(_TXT2IMG_PIPE.scheduler.config)
    
    logger.info(f"Applying LCM LoRA adapter: {lora_id}")
    _TXT2IMG_PIPE.load_lora_weights(lora_id)
    # Fusing LoRA makes inference faster
    _TXT2IMG_PIPE.fuse_lora()
    _TXT2IMG_PIPE.to(device)

    # We can share the components to save memory
    _IMG2IMG_PIPE = AutoPipelineForImage2Image.from_pipe(_TXT2IMG_PIPE)
    
    return _TXT2IMG_PIPE, _IMG2IMG_PIPE


def _pil_to_base64_data_uri(img: Image.Image) -> str:
    """Return a base64 encoded data URI for a PIL Image."""
    buffered = BytesIO()
    img.save(buffered, format="JPEG", quality=85)
    img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
    return f"data:image/jpeg;base64,{img_str}"


def _base64_to_pil(data_url: str) -> Image.Image:
    """Convert a base64 data URI to a PIL Image."""
    encoded = data_url.split(",")[1] if "," in data_url else data_url
    image_data = base64.b64decode(encoded)
    return Image.open(BytesIO(image_data)).convert("RGB")


def generate_image(prompt: str, config: AppConfig, profile: str, init_image_url: Optional[str] = None) -> str:
    """Generate an image using LCM and return a markdown-compatible base64 payload.
    
    Supports txt2img or img2img if init_image_url is provided.
    """
    import torch
    
    try:
        txt2img_pipe, img2img_pipe = _ensure_pipelines(config, profile)
    except Exception as exc:
        raise ImageGenerationError(f"Failed to load image generation model: {exc}") from exc

    device = _detect_device()
    use_fp16 = device == "mps"
    generator = torch.Generator(device=device)

    try:
        if init_image_url:
            # img2img path
            init_img = _base64_to_pil(init_image_url)
            # LCM requires very few steps, typically 4-8. Strength determines how much it changes.
            result = img2img_pipe(
                prompt=prompt,
                image=init_img,
                num_inference_steps=6,
                guidance_scale=1.5,
                strength=0.8,
                generator=generator,
                output_type="pil",
            ).images[0]
        else:
            # txt2img path
            result = txt2img_pipe(
                prompt=prompt,
                num_inference_steps=6,
                guidance_scale=1.5,
                generator=generator,
                output_type="pil",
            ).images[0]
            
        return _pil_to_base64_data_uri(result)
        
    except Exception as exc:
        raise ImageGenerationError(f"Failed to generate image: {exc}") from exc
