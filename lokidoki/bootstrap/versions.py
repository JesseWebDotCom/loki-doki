"""Pinned upstream binary versions + SHA-256 for bootstrap downloads.

Separate from :mod:`lokidoki.core.platform` (which lists *model* IDs) —
this file only pins runtime *binaries* the installer fetches. Every
entry is (filename, sha256) keyed by ``(os_name, arch)``. ``os_name``
is lowercase — ``darwin`` / ``linux`` / ``windows``. ``arch`` is the
raw ``platform.machine()`` value — ``arm64`` / ``aarch64`` / ``x86_64``.

Maintenance: re-run ``scripts/update_bootstrap_versions.py`` to refresh.
CI enforces format via ``tests/unit/bootstrap/test_versions.py``.
"""
from __future__ import annotations


PYTHON_BUILD_STANDALONE = {
    "tag": "20260414",
    "version": "3.12.13",
    "artifacts": {
        ("darwin", "arm64"): (
            "cpython-3.12.13+20260414-aarch64-apple-darwin-install_only.tar.gz",
            "8966b2bcd9fa03ba22c080ad15a86bc12e41a00122b16f4b3740e302261124d9",
        ),
        ("windows", "x86_64"): (
            "cpython-3.12.13+20260414-x86_64-pc-windows-msvc-install_only.tar.gz",
            "c5a9e011e284c49c48106ca177342f3e3f64e95b4c6652d4a382cc7c9bb1cc46",
        ),
        ("linux", "aarch64"): (
            "cpython-3.12.13+20260414-aarch64-unknown-linux-gnu-install_only.tar.gz",
            "355d981eafb9b2870af79ddc106ced7266b6f6d2101d8fbcb05620fa386642b9",
        ),
        ("linux", "x86_64"): (
            "cpython-3.12.13+20260414-x86_64-unknown-linux-gnu-install_only.tar.gz",
            "cdcf8724d46e4857f8db5ee9f4252dc2f5da34f7940294ec6b312389dd3f41e0",
        ),
    },
    "url_template": (
        "https://github.com/astral-sh/python-build-standalone/"
        "releases/download/{tag}/{filename}"
    ),
}


UV = {
    "version": "0.11.6",
    "artifacts": {
        ("darwin", "arm64"): (
            "uv-aarch64-apple-darwin.tar.gz",
            "4b69a4e366ec38cd5f305707de95e12951181c448679a00dce2a78868dfc9f5b",
        ),
        ("windows", "x86_64"): (
            "uv-x86_64-pc-windows-msvc.zip",
            "99aa60edd017a256dbf378f372d1cff3292dbc6696e0ea01716d9158d773ab77",
        ),
        ("linux", "aarch64"): (
            "uv-aarch64-unknown-linux-gnu.tar.gz",
            "d5be4bf7015ea000378cb3c3aba53ba81a8673458ace9c7fa25a0be005b74802",
        ),
        ("linux", "x86_64"): (
            "uv-x86_64-unknown-linux-gnu.tar.gz",
            "0c6bab77a67a445dc849ed5e8ee8d3cb333b6e2eba863643ce1e228075f27943",
        ),
    },
    "url_template": (
        "https://github.com/astral-sh/uv/releases/download/{version}/{filename}"
    ),
}


# Vite 8 / rolldown mandates node ≥ 20.19. Pinning the nearest LTS patch
# that satisfies the engine field avoids "vite requires node 20.19+"
# hard errors during ``npm run build``.
NODE = {
    "version": "20.19.0",
    "artifacts": {
        ("darwin", "arm64"): (
            "node-v20.19.0-darwin-arm64.tar.gz",
            "c016cd1975a264a29dc1b07c6fbe60d5df0a0c2beb4113c0450e3d998d1a0d9c",
        ),
        ("windows", "x86_64"): (
            "node-v20.19.0-win-x64.zip",
            "be72284c7bc62de07d5a9fd0ae196879842c085f11f7f2b60bf8864c0c9d6a4f",
        ),
        ("linux", "aarch64"): (
            "node-v20.19.0-linux-arm64.tar.xz",
            "dbe339e55eb393955a213e6b872066880bb9feceaa494f4d44c7aac205ec2ab9",
        ),
        ("linux", "x86_64"): (
            "node-v20.19.0-linux-x64.tar.xz",
            "b4e336584d62abefad31baecff7af167268be9bb7dd11f1297112e6eed3ca0d5",
        ),
    },
    "url_template": "https://nodejs.org/dist/v{version}/{filename}",
}


# Piper's MIT-licensed binary releases only ship the mac/windows/linux
# multi-arch bundle under the ``2023.11.14-2`` tag. Newer tags (``v1.2.0``
# and later) drop mac + windows, and the post-transfer GPL repo was
# explicitly removed in commit cfb0872. Pin this tag.
PIPER = {
    "version": "2023.11.14-2",
    "artifacts": {
        ("darwin", "arm64"): (
            "piper_macos_aarch64.tar.gz",
            "6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc",
        ),
        ("windows", "x86_64"): (
            "piper_windows_amd64.zip",
            "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
        ),
        ("linux", "aarch64"): (
            "piper_linux_aarch64.tar.gz",
            "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
        ),
        ("linux", "x86_64"): (
            "piper_linux_x86_64.tar.gz",
            "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
        ),
    },
    "url_template": (
        "https://github.com/rhasspy/piper/releases/download/{version}/{filename}"
    ),
}


PIPER_VOICES: dict[str, dict[str, tuple[str, str]]] = {
    "en_US-lessac-high": {
        "onnx": (
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/"
            "en/en_US/lessac/high/en_US-lessac-high.onnx",
            "4cabf7c3a638017137f34a1516522032d4fe3f38228a843cc9b764ddcbcd9e09",
        ),
        "config": (
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/"
            "en/en_US/lessac/high/en_US-lessac-high.onnx.json",
            "db42b97d9859f257bc1561b8ed980e7fb2398402050a74ddd6cbec931a92412f",
        ),
    },
    "en_US-lessac-medium": {
        "onnx": (
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/"
            "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
            "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
        ),
        "config": (
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/"
            "en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
            "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
        ),
    },
}


# ``faster-whisper small.en`` intentionally has no entry: faster-whisper's
# CTranslate2 backend fetches on first use; the wizard just warms its HF
# cache. ``whisper.cpp base.en`` needs an explicit GGML download.
WHISPER: dict[str, tuple[str, str]] = {
    "whisper.cpp base.en": (
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
        "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    ),
}


# Prebuilt llama.cpp server binaries. Mac is absent because Apple Silicon
# uses MLX (see :data:`MLX_LM`); Intel macs are unsupported.
# - windows/linux x86_64 → Vulkan build (covers NVIDIA/AMD/Intel GPUs).
# - linux aarch64 → plain CPU/NEON build; Vulkan isn't useful on Pi 5.
LLAMA_CPP = {
    "version": "b8797",
    "artifacts": {
        ("windows", "x86_64"): (
            "llama-b8797-bin-win-vulkan-x64.zip",
            "fee8b7a27d85a66da09f98c81ee984041779dc2ec698e0fcc9940bcc7edd2337",
        ),
        ("linux", "x86_64"): (
            "llama-b8797-bin-ubuntu-vulkan-x64.tar.gz",
            "efbff9087d26b69e995aa18fa8a7e2af39270d0863dcdcf5a07bc4bd2d761be5",
        ),
        ("linux", "aarch64"): (
            "llama-b8797-bin-ubuntu-arm64.tar.gz",
            "c15e108663bd7c23147fc926baeab14812a07b532bc564ccce6f799c5889266b",
        ),
    },
    "url_template": (
        "https://github.com/ggml-org/llama.cpp/releases/download/{version}/{filename}"
    ),
}


# MLX engine is a Python package, not a prebuilt binary — ``uv sync``
# from chunk 3 installs it (gated to Apple Silicon via pyproject.toml
# marker). This constant exists so the bootstrap can assert the
# installed ``mlx_lm.__version__`` matches what we validated against.
MLX_LM = {"version": "0.31.2"}


# llama.cpp loads vision models as two files: the language-model weights
# (``.gguf``) and the visual projector (``mmproj-*.gguf``). Keys match
# the values of ``PLATFORM_MODELS[profile]["vision_model"]`` on llama.cpp
# profiles. We do not pin per-file sha256 — HF commit pinning via
# ``<repo_id>@<sha>`` in the catalog covers integrity.
VISION_MMPROJ: dict[str, dict[str, str]] = {
    "Qwen/Qwen2-VL-7B-Instruct-GGUF:Q4_K_M": {
        "weights_filename": "Qwen2-VL-7B-Instruct-Q4_K_M.gguf",
        "mmproj_filename": "mmproj-Qwen2-VL-7B-Instruct-f16.gguf",
    },
    "Qwen/Qwen2-VL-2B-Instruct-GGUF:Q4_K_M": {
        "weights_filename": "Qwen2-VL-2B-Instruct-Q4_K_M.gguf",
        "mmproj_filename": "mmproj-Qwen2-VL-2B-Instruct-f16.gguf",
    },
}


PYTHON_MIN_VERSION = (3, 8, 0)
"""Floor for the *system* Python that launches Layer 1. The embedded
python-build-standalone interpreter (3.12) runs Layer 2 once the wizard
has installed it into ``.lokidoki/python/``."""


def os_arch_key(os_name: str, arch: str) -> tuple[str, str]:
    """Normalise ``(platform.system(), platform.machine())`` into the
    ``(os_name, arch)`` tuple used as keys in this module.

    ``platform.system()`` returns capitalised values (``Darwin``,
    ``Linux``, ``Windows``); this module uses lowercase. ``arch`` is
    passed through unchanged.
    """
    mapping = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}
    return (mapping.get(os_name, os_name.lower()), arch)
