"""Installer utility functions."""

from __future__ import annotations

import base64
import hashlib
import os
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

MAC_FACE_MODEL_URL = (
    "https://hailo-model-zoo.s3.eu-west-2.amazonaws.com/"
    "HailoNets/MCPReID/personface_detector/yolov5s_personface/2023-04-25/yolov5s_personface.zip"
)
MAC_FACE_MODEL_NAME = "yolov5s_personface.onnx"


def hash_password(password: str) -> str:
    """Hash a password using stdlib-only PBKDF2."""
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return "$".join(
        [
            "pbkdf2_sha256",
            "120000",
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        ]
    )


def ensure_personface_model(model_name: str, cache_dir: Path) -> Path:
    """Download and extract the Mac ONNX face detector."""
    requested_name = model_name.strip()
    if requested_name not in {"yolov5s_personface", "yolov5s_personface.onnx"}:
        raise RuntimeError(f"Unsupported Mac face detector model '{model_name}'.")
    cache_dir.mkdir(parents=True, exist_ok=True)
    model_path = cache_dir / MAC_FACE_MODEL_NAME
    if model_path.exists():
        return model_path
    zip_path = cache_dir / "yolov5s_personface.zip"
    if not zip_path.exists():
        try:
            urllib.request.urlretrieve(MAC_FACE_MODEL_URL, zip_path)
        except urllib.error.URLError as exc:
            raise RuntimeError(
                f"Mac face detector pack could not be downloaded from {MAC_FACE_MODEL_URL}: {exc}"
            ) from exc
    with zipfile.ZipFile(zip_path) as archive:
        archive.extract(MAC_FACE_MODEL_NAME, cache_dir)
    return model_path
