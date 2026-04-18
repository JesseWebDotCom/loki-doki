"""Preflight steps — download + install embedded toolchain into ``.lokidoki/``.

Each submodule owns one concern: the embedded CPython, the ``uv`` binary,
the project dependency sync, the embedded Node.js runtime + frontend
build, and the CPU-only audio stack (Piper, Whisper, openWakeWord).
``steps.py`` binds these to pipeline step IDs.
"""
from .frontend import build_frontend, install_frontend_deps
from .node_runtime import ensure_node
from .piper_runtime import ensure_tts_voice
from .python_deps import sync_python_deps
from .python_runtime import ensure_embedded_python
from .uv_runtime import ensure_uv
from .wake_word import ensure_wake_word
from .whisper_runtime import ensure_whisper_model

__all__ = [
    "build_frontend",
    "ensure_embedded_python",
    "ensure_node",
    "ensure_tts_voice",
    "ensure_uv",
    "ensure_wake_word",
    "ensure_whisper_model",
    "install_frontend_deps",
    "sync_python_deps",
]
