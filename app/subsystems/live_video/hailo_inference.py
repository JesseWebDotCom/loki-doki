"""Shared Hailo HEF image-inference helpers for live-video detectors."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Callable

from app.providers.hailo import (
    exclusive_hailo_device,
    hailo_device_busy,
    resolve_vision_hef_path,
    shared_vdevice,
)
from app.providers.types import ProviderSpec
from app.subsystems.text.client import ProviderRequestError


@dataclass(frozen=True)
class HailoInferenceResult:
    """One Hailo detector inference result."""

    input_name: str
    input_shape: tuple[int, ...]
    input_order: str
    outputs: dict[str, Any]
    output_orders: dict[str, str]


def decode_rgb_image(image_base64: str):
    """Decode a base64 payload into one RGB pillow image."""
    from PIL import Image

    raw = base64.b64decode(image_base64)
    with Image.open(BytesIO(raw)) as image:
        return image.convert("RGB")


def run_hailo_image_inference(
    provider: ProviderSpec,
    image_base64: str,
    prepare_input: Callable[[Any, tuple[int, int], str], tuple[Any, dict[str, Any]]],
) -> HailoInferenceResult:
    """Run one blocking Hailo HEF inference for one detector image payload."""
    hef_path = resolve_vision_hef_path(provider.model)
    if hef_path is None:
        raise ProviderRequestError(f"Hailo detector HEF '{provider.model}' is not available.")
    try:
        image = decode_rgb_image(image_base64)
        return _infer_with_retry(hef_path, image, prepare_input)
    except ProviderRequestError:
        raise
    except Exception as exc:
        raise ProviderRequestError(f"Hailo detector request failed: {exc}") from exc


def _infer_with_retry(
    hef_path,
    image: Any,
    prepare_input: Callable[[Any, tuple[int, int], str], tuple[Any, dict[str, Any]]],
) -> HailoInferenceResult:
    """Retry once with an exclusive device lease when Hailo is busy."""
    try:
        return _run_hailo_inference(hef_path, image, prepare_input)
    except Exception as exc:
        if not hailo_device_busy(str(exc)):
            raise
    with exclusive_hailo_device():
        return _run_hailo_inference(hef_path, image, prepare_input)


def _run_hailo_inference(
    hef_path,
    image: Any,
    prepare_input: Callable[[Any, tuple[int, int], str], tuple[Any, dict[str, Any]]],
) -> HailoInferenceResult:
    """Configure one HEF and run one inference batch."""
    try:
        from hailo_platform import (
            ConfigureParams,
            FormatType,
            HailoStreamInterface,
            HEF,
            InferVStreams,
            InputVStreamParams,
            OutputVStreamParams,
        )
    except ImportError as exc:
        raise ProviderRequestError(f"Hailo detector dependencies are unavailable: {exc}") from exc
    hef = HEF(str(hef_path))
    input_info = hef.get_input_vstream_infos()[0]
    input_order = str(input_info.format.order).split(".")[-1]
    input_size = input_size_from_shape(tuple(int(value) for value in input_info.shape), input_order)
    input_tensor, metadata = prepare_input(image, input_size, input_order)
    configure_params = ConfigureParams.create_from_hef(hef, HailoStreamInterface.INTEGRATED)
    with shared_vdevice() as vdevice:
        configured = vdevice.configure(hef, configure_params)
        configured_network = configured[0] if isinstance(configured, (list, tuple)) else configured
        input_params = InputVStreamParams.make_from_network_group(
            configured_network,
            quantized=False,
            format_type=FormatType.FLOAT32,
        )
        output_params = OutputVStreamParams.make_from_network_group(
            configured_network,
            quantized=False,
            format_type=FormatType.FLOAT32,
        )
        with InferVStreams(configured_network, input_params, output_params, tf_nms_format=False) as infer_pipeline:
            outputs = infer_pipeline.infer({input_info.name: input_tensor})
        output_orders = {
            info.name: str(info.format.order).split(".")[-1]
            for info in configured_network.get_output_vstream_infos()
        }
    return HailoInferenceResult(
        input_name=input_info.name,
        input_shape=tuple(int(value) for value in input_info.shape),
        input_order=input_order,
        outputs={"__metadata__": metadata, **outputs},
        output_orders=output_orders,
    )


def input_size_from_shape(shape: tuple[int, ...], order: str) -> tuple[int, int]:
    """Return width and height from a Hailo input shape and format order."""
    normalized_order = order.upper()
    if normalized_order == "NCHW" and len(shape) >= 3:
        return int(shape[2]), int(shape[1])
    if normalized_order == "NHWC" and len(shape) >= 3:
        return int(shape[1]), int(shape[0])
    if len(shape) >= 2:
        return int(shape[1]), int(shape[0])
    raise ProviderRequestError(f"Unexpected Hailo detector input shape: {shape}")


def tensor_for_order(array: Any, order: str) -> Any:
    """Convert one NCHW tensor into the Hailo input order."""
    numpy = __import__("numpy")
    normalized_order = order.upper()
    if normalized_order == "NCHW":
        return numpy.asarray(array, dtype=numpy.float32)
    if normalized_order == "NHWC":
        return numpy.transpose(array, (0, 2, 3, 1)).astype(numpy.float32, copy=False)
    raise ProviderRequestError(f"Unsupported Hailo detector input order '{order}'.")
