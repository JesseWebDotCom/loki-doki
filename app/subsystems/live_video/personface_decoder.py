"""Shared decoders for YOLOv5 person/face detector outputs."""

from __future__ import annotations

from typing import Any

from app.subsystems.live_video.face_cpu_detector import _nms
from app.subsystems.live_video.cpu_detector import _numpy_module


FACE_CLASS_INDEX = 1
RAW_PERSONFACE_CONFIDENCE_THRESHOLD = 0.2
HAILO_NMS_ORDERS = {
    "HAILO_NMS_BY_CLASS",
    "HAILO_NMS_BY_SCORE",
    "HAILO_NMS_ON_CHIP",
    "HAILO_NMS_WITH_BYTE_MASK",
}
YOLOV5_FACE_ANCHORS = (
    ((10.0, 13.0), (16.0, 30.0), (33.0, 23.0)),
    ((30.0, 61.0), (62.0, 45.0), (59.0, 119.0)),
    ((116.0, 90.0), (156.0, 198.0), (373.0, 326.0)),
)


def uses_nms_outputs(output_orders: dict[str, str]) -> bool:
    """Return whether any detector output uses a Hailo NMS ordering."""
    return any(order in HAILO_NMS_ORDERS for order in output_orders.values())


def decode_personface_nms_outputs(outputs: list[Any], metadata: dict[str, Any]) -> list[dict[str, Any]]:
    """Decode person/face NMS outputs and keep only the face bucket."""
    decoded: list[dict[str, Any]] = []
    for output in outputs:
        for detection in _face_bucket_rows(output):
            y1, x1, y2, x2, score = _row_fields(detection)
            decoded.append(
                {
                    **normalize_box(x1, y1, x2, y2, metadata),
                    "confidence": float(score),
                }
            )
    return sorted(decoded, key=lambda item: item["confidence"], reverse=True)


def decode_personface_raw_outputs(outputs: list[Any], metadata: dict[str, Any]) -> list[dict[str, Any]]:
    """Decode raw YOLOv5 person/face detector heads and keep only face boxes."""
    numpy = _numpy_module()
    decoded: list[dict[str, Any]] = []
    for output, anchors in zip(outputs, YOLOV5_FACE_ANCHORS):
        tensor = numpy.asarray(output)
        if tensor.ndim != 5:
            raise ValueError(f"Unsupported raw personface output shape: {tensor.shape}")
        tensor = tensor[0]
        if tensor.shape[-1] < 7:
            raise ValueError(f"Unsupported raw personface output shape: {tensor.shape}")
        anchor_count, grid_h, grid_w, _channel_count = tensor.shape
        grid_y, grid_x = numpy.meshgrid(numpy.arange(grid_h), numpy.arange(grid_w), indexing="ij")
        grid = numpy.stack((grid_x, grid_y), axis=-1)[None, :, :, :]
        stride_x = metadata["input_size"][0] / grid_w
        stride_y = metadata["input_size"][1] / grid_h
        strides = numpy.asarray((stride_x, stride_y), dtype=numpy.float32)
        anchor_grid = numpy.asarray(anchors, dtype=numpy.float32).reshape((anchor_count, 1, 1, 2))
        prediction = 1.0 / (1.0 + numpy.exp(-tensor))
        centers = ((prediction[..., 0:2] * 2.0) - 0.5 + grid) * strides
        sizes = ((prediction[..., 2:4] * 2.0) ** 2) * anchor_grid
        objectness = prediction[..., 4]
        class_probs = prediction[..., 5:]
        class_scores = objectness[..., None] * class_probs
        face_scores = class_scores[..., FACE_CLASS_INDEX]
        face_indices = numpy.argwhere(face_scores >= RAW_PERSONFACE_CONFIDENCE_THRESHOLD)
        for anchor_index, row_index, col_index in face_indices:
            score = float(face_scores[anchor_index, row_index, col_index])
            center_x, center_y = centers[anchor_index, row_index, col_index]
            width, height = sizes[anchor_index, row_index, col_index]
            decoded.append(
                {
                    **normalize_box(
                        float(center_x - (width / 2.0)),
                        float(center_y - (height / 2.0)),
                        float(center_x + (width / 2.0)),
                        float(center_y + (height / 2.0)),
                        metadata,
                    ),
                    "confidence": score,
                }
            )
    return _nms(decoded, 0.4)


def normalize_box(x1: float, y1: float, x2: float, y2: float, metadata: dict[str, Any]) -> dict[str, float]:
    """Project one detector box back into normalized image coordinates."""
    width = metadata["width"]
    height = metadata["height"]
    scale = metadata["scale"]
    if max(abs(x1), abs(x2)) <= 1.5 and max(abs(y1), abs(y2)) <= 1.5:
        input_width, input_height = metadata["input_size"]
        x1 *= input_width
        x2 *= input_width
        y1 *= input_height
        y2 *= input_height
    left = max(0.0, min(width, x1 / scale))
    top = max(0.0, min(height, y1 / scale))
    right = max(left, min(width, x2 / scale))
    bottom = max(top, min(height, y2 / scale))
    return {
        "x": left / width,
        "y": top / height,
        "width": (right - left) / width,
        "height": (bottom - top) / height,
    }


def _face_bucket_rows(output: Any) -> list[Any]:
    """Return only the face rows from one NMS output tensor/list."""
    rows = _unwrap_container(output)
    if not rows:
        return []
    if _is_numeric_row(rows):
        return [rows]
    if _looks_like_class_buckets(rows):
        bucket_index = FACE_CLASS_INDEX if len(rows) > FACE_CLASS_INDEX else 0
        return _flatten_detection_rows(rows[bucket_index])
    return _flatten_detection_rows(rows)


def _looks_like_class_buckets(rows: list[Any]) -> bool:
    """Return whether this payload looks like a [class][row][values] structure."""
    if len(rows) < 2:
        return False
    return all(_is_detection_sequence(bucket) or not _unwrap_container(bucket) for bucket in rows[:2])


def _is_detection_sequence(value: Any) -> bool:
    """Return whether one value looks like a sequence of detection rows."""
    rows = _unwrap_container(value)
    if not rows:
        return True
    if _is_numeric_row(rows):
        return True
    sample = rows[0]
    if hasattr(sample, "y_min"):
        return True
    return _is_numeric_row(sample)


def _unwrap_container(value: Any) -> list[Any]:
    """Collapse one nested list/array batch dimension into a Python list."""
    if hasattr(value, "tolist"):
        value = value.tolist()
    while isinstance(value, list) and len(value) == 1 and isinstance(value[0], list):
        value = value[0]
    if isinstance(value, list):
        return value
    return [value]


def _flatten_detection_rows(value: Any) -> list[Any]:
    """Flatten one nested detector payload into a list of numeric rows."""
    rows = _unwrap_container(value)
    if not rows:
        return []
    if _is_numeric_row(rows):
        return [rows]
    flattened: list[Any] = []
    for row in rows:
        if _is_numeric_row(row):
            flattened.append(row)
            continue
        flattened.extend(_flatten_detection_rows(row))
    return flattened


def _row_fields(detection: Any) -> tuple[float, float, float, float, float]:
    """Return one NMS detection row as box coordinates plus confidence."""
    if hasattr(detection, "y_min"):
        return (
            float(detection.y_min),
            float(detection.x_min),
            float(detection.y_max),
            float(detection.x_max),
            float(detection.score),
        )
    values = [float(value) for value in detection]
    if len(values) < 5:
        raise ValueError(f"Unsupported person/face detection row: {detection}")
    return values[0], values[1], values[2], values[3], values[4]


def _is_numeric_row(value: Any) -> bool:
    """Return whether one value looks like a flat numeric detection row."""
    if hasattr(value, "y_min"):
        return True
    if not isinstance(value, list):
        return False
    return len(value) >= 5 and all(isinstance(item, (int, float)) for item in value[:5])
