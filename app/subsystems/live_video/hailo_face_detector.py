"""Hailo-backed face detection helpers."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from app.providers.types import ProviderSpec
from app.subsystems.live_video.face_cpu_detector import (
    _decode_outputs,
    _nms,
    _resize_for_detector,
)
from app.subsystems.live_video.hailo_inference import run_hailo_image_inference, tensor_for_order
from app.subsystems.live_video.personface_decoder import (
    decode_personface_nms_outputs,
    uses_nms_outputs,
)


def detect_hailo_faces(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Run Hailo face detection for one frame."""
    inference = run_hailo_image_inference(provider, image_base64, _prepare_hailo_face_input)
    metadata = inference.outputs["__metadata__"]
    outputs = [value for name, value in inference.outputs.items() if name != "__metadata__"]
    if uses_nms_outputs(inference.output_orders):
        return tuple(decode_personface_nms_outputs(outputs, metadata))
    session_stub = SimpleNamespace(get_outputs=lambda: [None] * len(outputs))
    detections = _decode_outputs(
        session_stub,
        [_first_frame(output) for output in outputs],
        metadata,
        metadata["input_size"],
        0.5,
    )
    return tuple(_nms(detections, 0.4))


def _prepare_hailo_face_input(image: Any, input_size: tuple[int, int], input_order: str) -> tuple[Any, dict[str, Any]]:
    """Prepare one image for a Hailo face detector."""
    tensor, resize = _resize_for_detector(image, input_size)
    return tensor_for_order(tensor, input_order), {**resize, "input_size": input_size}


def _first_frame(output: Any) -> Any:
    """Return the first batch frame for one raw Hailo output."""
    if hasattr(output, "shape") and len(output.shape) > 0 and int(output.shape[0]) == 1:
        return output[0]
    return output
