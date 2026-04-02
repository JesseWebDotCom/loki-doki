"""Hailo-backed object detection helpers."""

from __future__ import annotations

from typing import Any

from app.providers.hailo import exclusive_hailo_device, hailo_device_busy, resolve_vision_hef_path, shared_vdevice
from app.providers.types import ProviderSpec
from app.subsystems.live_video.coco import COCO_LABELS
from app.subsystems.live_video.cpu_detector import _decode_predictions, _image_module, _numpy_module
from app.subsystems.live_video.hailo_inference import (
    decode_rgb_image,
    input_size_from_shape,
    run_hailo_image_inference,
    tensor_for_order,
)
from app.subsystems.text.client import ProviderRequestError


HAILO_NMS_ORDERS = {
    "HAILO_NMS_BY_CLASS",
    "HAILO_NMS_BY_SCORE",
    "HAILO_NMS_ON_CHIP",
    "HAILO_NMS_WITH_BYTE_MASK",
}


def detect_hailo_objects(provider: ProviderSpec, image_base64: str) -> tuple[dict[str, Any], ...]:
    """Run Hailo object detection for one frame."""
    if _uses_infer_model_api(provider.model):
        return tuple(_detect_hailo_objects_with_infer_model(provider, image_base64))
    inference = run_hailo_image_inference(provider, image_base64, _prepare_hailo_image)
    metadata = inference.outputs["__metadata__"]
    if _uses_nms_outputs(inference.output_orders):
        return tuple(_decode_nms_outputs(inference.outputs, metadata))
    raw_output = _first_raw_output(inference.outputs)
    return tuple(_decode_predictions(raw_output, metadata))


def _detect_hailo_objects_with_infer_model(provider: ProviderSpec, image_base64: str) -> list[dict[str, Any]]:
    """Run one packaged Hailo object detector through the infer-model API."""
    hef_path = resolve_vision_hef_path(provider.model)
    if hef_path is None:
        raise ProviderRequestError(f"Hailo detector HEF '{provider.model}' is not available.")
    image = decode_rgb_image(image_base64)
    try:
        return _run_infer_model_detection(hef_path, image)
    except Exception as exc:
        if hailo_device_busy(str(exc)):
            with exclusive_hailo_device():
                return _run_infer_model_detection(hef_path, image)
        raise ProviderRequestError(f"Hailo detector request failed: {exc}") from exc


def _prepare_hailo_image(image: Any, input_size: tuple[int, int], input_order: str) -> tuple[Any, dict[str, float]]:
    """Prepare one RGB image for a Hailo YOLO detector input."""
    image_module = _image_module()
    numpy = _numpy_module()
    width, height = image.size
    input_width, input_height = input_size
    scale = min(input_width / width, input_height / height)
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    resized = image.resize((resized_width, resized_height), image_module.Resampling.BILINEAR)
    pad_x = (input_width - resized_width) // 2
    pad_y = (input_height - resized_height) // 2
    canvas = image_module.new("RGB", (input_width, input_height), (114, 114, 114))
    canvas.paste(resized, (pad_x, pad_y))
    array = numpy.asarray(canvas, dtype=numpy.float32) / 255.0
    tensor = tensor_for_order(array[None, :, :, :], input_order)
    metadata = {
        "width": float(width),
        "height": float(height),
        "scale": float(scale),
        "pad_x": float(pad_x),
        "pad_y": float(pad_y),
        "input_width": float(input_width),
        "input_height": float(input_height),
    }
    return tensor, metadata


def _prepare_hailo_uint8_image(
    image: Any,
    input_size: tuple[int, int],
    input_order: str,
) -> tuple[Any, dict[str, float]]:
    """Prepare one RGB image for a quantized packaged Hailo detector input."""
    image_module = _image_module()
    numpy = _numpy_module()
    width, height = image.size
    input_width, input_height = input_size
    scale = min(input_width / width, input_height / height)
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    resized = image.resize((resized_width, resized_height), image_module.Resampling.BILINEAR)
    pad_x = (input_width - resized_width) // 2
    pad_y = (input_height - resized_height) // 2
    canvas = image_module.new("RGB", (input_width, input_height), (114, 114, 114))
    canvas.paste(resized, (pad_x, pad_y))
    array = numpy.array(canvas, dtype=numpy.uint8, copy=True)
    normalized_order = input_order.upper()
    if normalized_order == "NHWC":
        tensor = numpy.ascontiguousarray(array)
    elif normalized_order == "NCHW":
        tensor = numpy.ascontiguousarray(numpy.transpose(array, (2, 0, 1)))
    else:
        raise ProviderRequestError(f"Unsupported Hailo detector input order '{input_order}'.")
    metadata = {
        "width": float(width),
        "height": float(height),
        "scale": float(scale),
        "pad_x": float(pad_x),
        "pad_y": float(pad_y),
        "input_width": float(input_width),
        "input_height": float(input_height),
    }
    return tensor, metadata


def _uses_nms_outputs(output_orders: dict[str, str]) -> bool:
    """Return whether the Hailo detector emits NMS-formatted outputs."""
    return any(order in HAILO_NMS_ORDERS for order in output_orders.values())


def _uses_infer_model_api(model_name: str) -> bool:
    """Return whether this detector should use Hailo's infer-model API."""
    normalized = model_name.strip().lower()
    return normalized.endswith("_h10.hef") or normalized.endswith("_h15.hef")


def _run_infer_model_detection(hef_path, image: Any) -> list[dict[str, Any]]:
    """Run one packaged Hailo detector through `InferModel`."""
    try:
        from hailo_platform import VDevice
    except ImportError as exc:
        raise ProviderRequestError(f"Hailo detector dependencies are unavailable: {exc}") from exc
    numpy = _numpy_module()
    with shared_vdevice() as vdevice:
        infer_model = vdevice.create_infer_model(str(hef_path))
        input_spec = infer_model.input()
        input_order = str(input_spec.format.order).split(".")[-1]
        input_size = input_size_from_shape(tuple(int(value) for value in input_spec.shape), input_order)
        input_buffer, metadata = _prepare_hailo_uint8_image(image, input_size, input_order)
        output_name = infer_model.output_names[0]
        output_spec = infer_model.output(output_name)
        configured = infer_model.configure()
        try:
            bindings = configured.create_bindings()
            writable_input = numpy.array(input_buffer, copy=True, order="C")
            bindings.input().set_buffer(writable_input)
            output_shape = tuple(int(value) for value in output_spec.shape)
            output_dtype = numpy.float32 if "FLOAT32" in str(output_spec.format.type).upper() else numpy.uint8
            bindings.output().set_buffer(numpy.empty(output_shape, dtype=output_dtype))
            configured.run([bindings], 10_000)
            output = numpy.array(bindings.output().get_buffer(), copy=True)
        finally:
            configured.shutdown()
    output_order = str(output_spec.format.order).split(".")[-1]
    outputs = {"__metadata__": metadata, output_name: output}
    if output_order in HAILO_NMS_ORDERS:
        return _decode_nms_outputs(outputs, metadata)
    return _decode_predictions(output, metadata)


def _first_raw_output(outputs: dict[str, Any]) -> Any:
    """Return the first non-NMS array output."""
    output = next(value for name, value in outputs.items() if name != "__metadata__")
    if hasattr(output, "shape"):
        return output
    if isinstance(output, list) and output and hasattr(output[0], "shape"):
        return output[0]
    return output


def _decode_nms_outputs(outputs: dict[str, Any], metadata: dict[str, float]) -> list[dict[str, Any]]:
    """Decode one Hailo NMS output payload into shared object detections."""
    decoded: list[dict[str, Any]] = []
    for name, output in outputs.items():
        if name == "__metadata__":
            continue
        for class_id, detection in _iter_nms_detections(output):
            y1, x1, y2, x2, score = _nms_detection_fields(detection, class_id)
            box = _normalize_box(x1, y1, x2, y2, metadata)
            decoded.append(
                {
                    "label": COCO_LABELS[class_id] if 0 <= class_id < len(COCO_LABELS) else str(class_id),
                    "confidence": float(score),
                    **box,
                }
            )
    return sorted(decoded, key=lambda item: item["confidence"], reverse=True)


def _iter_nms_detections(output: Any):
    """Yield one `(class_id, detection)` pair from a Hailo NMS output."""
    frame = output[0] if isinstance(output, list) and output and isinstance(output[0], list) else output
    if isinstance(frame, list):
        for class_id, detections in enumerate(frame):
            for detection in detections:
                yield class_id, detection
        return
    for detection in frame:
        class_id = int(getattr(detection, "class_id", 0))
        yield class_id, detection


def _nms_detection_fields(detection: Any, class_id: int) -> tuple[float, float, float, float, float]:
    """Return one detection as `(y1, x1, y2, x2, score)`."""
    if hasattr(detection, "y_min"):
        return (
            float(detection.y_min),
            float(detection.x_min),
            float(detection.y_max),
            float(detection.x_max),
            float(detection.score),
        )
    values = [float(value) for value in detection[:5]]
    if len(values) < 5:
        raise ValueError(f"Unsupported Hailo object detection row for class {class_id}: {detection}")
    return values[0], values[1], values[2], values[3], values[4]


def _normalize_box(x1: float, y1: float, x2: float, y2: float, metadata: dict[str, float]) -> dict[str, float]:
    """Project one detector-space box back into normalized original-image coordinates."""
    input_width = metadata["input_width"]
    input_height = metadata["input_height"]
    if max(abs(x1), abs(x2)) <= 1.5 and max(abs(y1), abs(y2)) <= 1.5:
        x1 *= input_width
        x2 *= input_width
        y1 *= input_height
        y2 *= input_height
    x1 = (x1 - metadata["pad_x"]) / metadata["scale"]
    x2 = (x2 - metadata["pad_x"]) / metadata["scale"]
    y1 = (y1 - metadata["pad_y"]) / metadata["scale"]
    y2 = (y2 - metadata["pad_y"]) / metadata["scale"]
    width = metadata["width"]
    height = metadata["height"]
    left = max(0.0, min(width, x1))
    top = max(0.0, min(height, y1))
    right = max(left, min(width, x2))
    bottom = max(top, min(height, y2))
    return {
        "x": left / width,
        "y": top / height,
        "width": (right - left) / width,
        "height": (bottom - top) / height,
    }
