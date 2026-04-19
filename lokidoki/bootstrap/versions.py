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


TEMURIN_JRE = {
    "version": "21.0.5+11",
    "artifacts": {
        ("darwin", "arm64"): (
            "OpenJDK21U-jre_aarch64_mac_hotspot_21.0.5_11.tar.gz",
            "12249a1c5386957c93fc372260c483ae921b1ec6248a5136725eabd0abc07f93",
        ),
        ("windows", "x86_64"): (
            "OpenJDK21U-jre_x64_windows_hotspot_21.0.5_11.zip",
            "1749b36cfac273cee11802bf3e90caada5062de6a3fef1a3814c0568b25fd654",
        ),
        ("linux", "aarch64"): (
            "OpenJDK21U-jre_aarch64_linux_hotspot_21.0.5_11.tar.gz",
            "e4d02c33aeaf8e1148c1c505e129a709c5bc1889e855d4fb4f001b1780db42b4",
        ),
        ("linux", "x86_64"): (
            "OpenJDK21U-jre_x64_linux_hotspot_21.0.5_11.tar.gz",
            "553dda64b3b1c3c16f8afe402377ffebe64fb4a1721a46ed426a91fd18185e62",
        ),
    },
    "url_template": (
        "https://github.com/adoptium/temurin21-binaries/releases/download/"
        "jdk-{version}/{filename}"
    ),
}


PLANETILER = {
    "version": "0.8.4",
    "filename": "planetiler.jar",
    "sha256": "75ff1de32b104facfe2a9c5b1b396967de2f06fa4fd2b63d1c8b94cf14bbccb0",
    "url_template": (
        "https://github.com/onthegomap/planetiler/releases/download/"
        "v{version}/planetiler.jar"
    ),
}


# planetiler's ``--download`` flag fetches these two archives at build
# time; the ``install-planetiler-data`` preflight pre-seeds them into
# ``.lokidoki/tools/planetiler/sources/`` so ``building_streets`` runs
# offline. Upstream serves mutable URLs (no per-version release tag) so
# the sha256 is the only reliable integrity pin — if it drifts, the
# preflight fails loudly and the operator refreshes the pin deliberately.
NATURAL_EARTH = {
    "version": "5.1.2",
    "filename": "natural_earth_vector.sqlite.zip",
    "sha256": "375da61836d4779dffa8b87887bc4faa94dac77745ba0ee3914bd7cbedf40a02",
    "url_template": (
        "https://naciscdn.org/naturalearth/packages/{filename}"
    ),
}


OSM_WATER_POLYGONS = {
    "version": "2025-01-30",
    "filename": "water-polygons-split-3857.zip",
    "sha256": "1711c438e8fefd9162e2aa9db566188445d72bfec25ac4cff9a1e23849df3382",
    "url_template": (
        "https://osmdata.openstreetmap.de/download/{filename}"
    ),
}


GRAPHHOPPER = {
    "version": "10.1",
    "filename": "graphhopper-web-10.1.jar",
    "sha256": "5419ff22309f4f584f6ae7eb03e6457589038ddd71ba50e62c927c8380986231",
    "url_template": (
        "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/"
        "{version}/{filename}"
    ),
}


# Protomaps basemaps-assets — PBF glyph range files the MapLibre style
# references via its ``glyphs:`` URL. Pinned to an immutable commit SHA
# (the upstream repo ships no release tags, so a commit SHA is the only
# content-addressed pin available). Only the ``fonts/Noto Sans Regular``
# subtree is extracted; the rest of the archive (sprites, icons) is
# discarded by the preflight.
GLYPHS_ASSETS = {
    "commit": "028c18f713baecad011301ff7a69acc39bcc2ae7",
    "filename": "basemaps-assets-028c18f7.tar.gz",
    "sha256": "57e40e8c512bd8042d0a3a251f19d0d1c8523ad963c666c3c6643bada4dc92d0",
    "url_template": (
        "https://github.com/protomaps/basemaps-assets/archive/{commit}.tar.gz"
    ),
}


# Piper voice models — synthesis uses the piper-tts Python package
# in-process (no CLI binary needed).
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


VALHALLA_RUNTIME = {
    "version": "3.5.0",
    "artifacts": {
        ("darwin", "arm64"): (
            "valhalla-3.5.0-darwin-arm64.tar.zst",
            "0" * 64,
        ),
        ("linux", "x86_64"): (
            "valhalla-3.5.0-linux-x86_64.tar.zst",
            "0" * 64,
        ),
        ("linux", "aarch64"): (
            "valhalla-3.5.0-linux-aarch64.tar.zst",
            "0" * 64,
        ),
        ("windows", "x86_64"): (
            "valhalla-3.5.0-windows-x86_64.tar.zst",
            "0" * 64,
        ),
    },
    "url_template": (
        "https://cdn.lokidoki.local/valhalla/{version}/{filename}"
    ),
}


# hailo-ollama is the Hailo HAT-aware Ollama fork. Only the linux/aarch64
# build is meaningful — the engine only ever runs on a Pi 5 + Hailo HAT.
# Filename, sha256, and version are pinned placeholders the operator
# refreshes via ``scripts/update_bootstrap_versions.py`` once Hailo
# publishes a stable release tag the wizard can fetch unattended.
HAILO_OLLAMA = {
    "version": "0.1.0",
    "artifacts": {
        ("linux", "aarch64"): (
            "hailo-ollama-linux-arm64.tar.gz",
            "0" * 64,
        ),
    },
    "url_template": (
        "https://github.com/hailo-ai/hailo-ollama/releases/download/"
        "v{version}/{filename}"
    ),
}


# Pinned HEF (Hailo Executable Format) weight files for ``pi_hailo``.
# Map: HEF filename → (url, sha256, approx_size_mb). Filenames must
# match the values in ``PLATFORM_MODELS["pi_hailo"]`` (vision_model,
# object_detector_model, face_detector_model). Sizes are advisory —
# the wizard surfaces them as ETA hints during ``ensure-hef-files``.
HEF_FILES: dict[str, tuple[str, str, int]] = {
    "yolov8m.hef": (
        "https://hailo-csdata.s3.eu-west-2.amazonaws.com/"
        "resources/hef/v2.13/yolov8m.hef",
        "0" * 64,
        50,
    ),
    "yolov5s_personface.hef": (
        "https://hailo-csdata.s3.eu-west-2.amazonaws.com/"
        "resources/hef/v2.13/yolov5s_personface.hef",
        "0" * 64,
        29,
    ),
    "Qwen2-VL-2B-Instruct.hef": (
        "https://hailo-csdata.s3.eu-west-2.amazonaws.com/"
        "resources/hef/v2.13/Qwen2-VL-2B-Instruct.hef",
        "0" * 64,
        420,
    ),
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
