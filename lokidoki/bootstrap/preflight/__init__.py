"""Preflight steps — download + install embedded toolchain into ``.lokidoki/``.

Each submodule owns one concern: the embedded CPython, the ``uv`` binary,
and the project dependency sync. ``steps.py`` binds these to pipeline
step IDs (``embed-python``, ``install-uv``, ``sync-python-deps``).
"""
from .python_runtime import ensure_embedded_python
from .uv_runtime import ensure_uv
from .python_deps import sync_python_deps

__all__ = ["ensure_embedded_python", "ensure_uv", "sync_python_deps"]
