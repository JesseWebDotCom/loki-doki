# Chunk 1 — Profile catalog + detection

## Goal

Establish the single source of truth for which engine runs on which platform, which models each platform uses, and how to detect the profile at launch. Every later chunk reads from this catalog.

No bootstrap code is touched in this chunk. Pure data + pure detection logic.

## Files

- `lokidoki/core/platform.py` — rewrite: add `llm_engine` field, new profile keys, full per-engine model catalog, `FACE_RECOGNITION_DEFAULTS`, `HAILO_RUNTIME_REQUIREMENTS`.
- `lokidoki/core/model_manager.py` — update `ModelPolicy` to read from the new catalog shape.
- `tests/unit/test_profile_catalog.py` — new.
- `AGENTS.md` — strip outdated Gemma references; point at `PLATFORM_MODELS` as source of truth. (Note: `CLAUDE.md` is a symlink to `AGENTS.md` — edit `AGENTS.md` only.)

Read-only: [lokidoki/orchestrator/core/config.py](../../lokidoki/orchestrator/core/config.py), [lokidoki/main.py](../../lokidoki/main.py). Confirm nothing hardcodes the old profile names (`pi5`, `pi`).

## Actions

1. **Replace `PLATFORM_MODELS`** with the five-profile catalog below. Drop `pi5`, `pi`. Every profile entry has these 14 keys; every key is required.

   | Key | mac | windows | linux | pi_cpu | pi_hailo |
   |---|---|---|---|---|---|
   | `llm_engine` | `mlx` | `llama_cpp_vulkan` | `llama_cpp_vulkan` | `llama_cpp_cpu` | `hailo_ollama` |
   | `llm_fast` | `mlx-community/Qwen3-8B-4bit` | `Qwen/Qwen3-8B-GGUF:Q4_K_M` | `Qwen/Qwen3-8B-GGUF:Q4_K_M` | `Qwen/Qwen3-4B-Instruct-GGUF:Q4_K_M` | `qwen3:1.7b` |
   | `llm_thinking` | `mlx-community/Qwen3-14B-4bit` | `Qwen/Qwen3-14B-GGUF:Q4_K_M` | `Qwen/Qwen3-14B-GGUF:Q4_K_M` | `Qwen/Qwen3-4B-GGUF:Q4_K_M` | `qwen3:4b` |
   | `vision_model` | `mlx-community/Qwen2-VL-7B-Instruct-4bit` | `Qwen/Qwen2-VL-7B-Instruct-GGUF:Q4_K_M` | `Qwen/Qwen2-VL-7B-Instruct-GGUF:Q4_K_M` | `Qwen/Qwen2-VL-2B-Instruct-GGUF:Q4_K_M` | `Qwen2-VL-2B-Instruct.hef` |
   | `object_detector_model` | `yolo26s` | `yolo26s` | `yolo26s` | `yolo26n` | `yolov8m.hef` |
   | `face_detector_model` | `scrfd_2.5g.onnx` | `scrfd_2.5g.onnx` | `scrfd_2.5g.onnx` | `scrfd_500m.onnx` | `yolov5s_personface.hef` |
   | `stt_model` | `faster-whisper small.en` | `faster-whisper small.en` | `faster-whisper small.en` | `whisper.cpp base.en` | `whisper.cpp base.en` |
   | `tts_voice` | `en_US-lessac-high` | `en_US-lessac-high` | `en_US-lessac-high` | `en_US-lessac-medium` | `en_US-lessac-medium` |
   | `wake_word` | `openWakeWord` | `openWakeWord` | `openWakeWord` | `openWakeWord` | `openWakeWord` |
   | `image_gen_model` | `black-forest-labs/FLUX.1-schnell` | `black-forest-labs/FLUX.1-schnell` | `black-forest-labs/FLUX.1-schnell` | `runwayml/stable-diffusion-v1-5` | `runwayml/stable-diffusion-v1-5` |
   | `image_gen_lcm_lora` | `None` | `None` | `None` | `latent-consistency/lcm-lora-sdv1-5` | `latent-consistency/lcm-lora-sdv1-5` |
   | `fast_keep_alive` | `-1` | `-1` | `-1` | `-1` | `-1` |
   | `thinking_keep_alive` | `"5m"` | `"5m"` | `"5m"` | `"5m"` | `"5m"` |

   Note the `pi_cpu` bump: `llm_fast=qwen3:4b-instruct` and `llm_thinking=qwen3:4b` (up from `qwen3:1.7b`). Justified because llama.cpp direct on Pi 5 frees the Ollama daemon's ~200 MB RAM overhead.

2. **Add `FACE_RECOGNITION_DEFAULTS`** keyed by profile. Mac / windows / linux use sharpness 65; pi_cpu / pi_hailo use 55. All five profiles use `recognition_threshold=0.4`, `min_face_size_px=80.0`. Copy the per-profile shapes from [loki-doki-old/app/config.py:130-146](../../../loki-doki-old/app/config.py#L130-L146); add windows + linux entries mirroring mac.

3. **Add `HAILO_RUNTIME_REQUIREMENTS`** — declarative, no code reads it yet:
   ```python
   HAILO_RUNTIME_REQUIREMENTS = {
       "device_node": "/dev/hailo0",
       "cli": "/usr/bin/hailortcli",
       "blacklist_file": "/etc/modprobe.d/blacklist-hailo.conf",
       "blacklist_line": "blacklist hailo_pci",
       "hef_files": ["yolov8m.hef", "yolov5s_personface.hef", "Qwen2-VL-2B-Instruct.hef"],
       "hailo_ollama_port": 8000,
   }
   ```

4. **Replace `detect_platform()` with `detect_profile()`**. Signature: `def detect_profile() -> Literal["mac", "windows", "linux", "pi_cpu", "pi_hailo"]`. Logic, in order:
   - `platform.system() == "Windows"` → `"windows"`.
   - `platform.system() == "Darwin"`:
     - If `platform.machine() != "arm64"` → raise `UnsupportedPlatform("Intel Macs are not supported. LokiDoki requires an Apple Silicon (arm64) Mac.")`. The Layer 0 launcher (chunk 8 on windows, chunk 3 on mac/linux) catches this and prints the message.
     - Else → `"mac"`.
   - `platform.system() == "Linux"`:
     - If `/proc/device-tree/model` or `/proc/cpuinfo` indicates Raspberry Pi 5 (`bcm2712` / `raspberry pi 5`):
       - If `/dev/hailo0` exists or `/usr/bin/hailortcli` exists → `"pi_hailo"`.
       - Else → `"pi_cpu"`.
     - Else → `"linux"`.
   - Anything else → `"linux"` (fallback).

5. **Do not keep a `detect_platform` alias.** This is a clean-install rewrite; there is no legacy to preserve. Update any in-repo caller. Grep: `rg -n 'detect_platform' lokidoki/ tests/`. Update each hit to `detect_profile`.

6. **Update `get_model_preset(profile=None)`**: default to `detect_profile()`; return the full dict for that profile.

7. **Update `ModelPolicy.__post_init__`** in [lokidoki/core/model_manager.py](../../lokidoki/core/model_manager.py):
   - Rename the `platform` field to `profile`.
   - Initialize `fast_model` / `thinking_model` from catalog keys `llm_fast` / `llm_thinking` (the current code already reads from these under a different internal name — verify).
   - Expose `engine` as a new property that returns `PLATFORM_MODELS[self.profile]["llm_engine"]`. Later chunks use it.

8. **Rewrite `AGENTS.md`** to remove outdated claims and consolidate:
   - Line 9 (backend): remove "Gemma 2B/9B". Rewrite as `Backend: FastAPI, uv, Qwen LLMs via profile-specific engines (MLX on mac, llama.cpp on win/linux/pi_cpu, hailo-ollama on pi_hailo).`
   - Lines 31-36 (stack): collapse the per-model lines into a single line pointing at the source of truth: `Models and engines: see lokidoki/core/platform.py::PLATFORM_MODELS for the authoritative per-profile catalog.`
   - Line 100 request path: rewrite as `[STT] → [Classifier] → [Router] → [Skill Handlers | fast Qwen | thinking Qwen] → [TTS]` — no Gemma.
   - Lines 111-113 routing bullets: drop the `tool_call → Gemma` bullet. Keep the other three.
   - Update any other Gemma / "function model" reference in the file.
   - Do not edit `CLAUDE.md` directly — it is a symlink to `AGENTS.md`.

9. **`tests/unit/test_profile_catalog.py`**, minimum cases:
   - `test_profiles_are_exactly_five`: `set(PLATFORM_MODELS.keys()) == {"mac","windows","linux","pi_cpu","pi_hailo"}`.
   - `test_every_profile_has_full_catalog`: all 14 required keys present.
   - `test_llm_engine_per_profile`: mac=`mlx`, win=`llama_cpp_vulkan`, linux=`llama_cpp_vulkan`, pi_cpu=`llama_cpp_cpu`, pi_hailo=`hailo_ollama`.
   - `test_detect_profile_macos_arm64`: monkeypatch `platform.system`/`machine` → `"mac"`.
   - `test_detect_profile_macos_intel_raises`: monkeypatch to darwin + x86_64 → raises `UnsupportedPlatform`.
   - `test_detect_profile_windows`: returns `"windows"`.
   - `test_detect_profile_linux_generic`: linux + non-Pi cpuinfo → `"linux"`.
   - `test_detect_profile_pi_cpu`: Pi 5 cpuinfo + no hailo device → `"pi_cpu"`.
   - `test_detect_profile_pi_hailo`: Pi 5 cpuinfo + `/dev/hailo0` exists → `"pi_hailo"`.
   - `test_face_recognition_has_all_five_profiles`.
   - `test_hailo_requirements_shape`.
   - `test_no_gemma_no_ollama_in_engines`: `"gemma" not in str(PLATFORM_MODELS)` (safety net against accidental regression); engine values are in the known set `{mlx, llama_cpp_vulkan, llama_cpp_cpu, hailo_ollama}`.

10. **grep check** — after edits, the following must return zero hits outside `docs/bootstrap_rewrite/`:
    - `rg -n 'gemma' lokidoki/ AGENTS.md` (case-insensitive; if a legacy fallback file like `gemma_fallback.py` still exists, flag it in this chunk's deferrals — do not delete it here, cleanup is explicitly out of scope).
    - `rg -n 'detect_platform|PLATFORM_MODELS\["pi5"\]|PLATFORM_MODELS\["pi"\]' lokidoki/`.
    - `rg -n 'STALE_OLLAMA_MODELS|MODEL_MIGRATIONS' lokidoki/` (these were never added; if present, something is off — stop and investigate).

## Verify

```bash
uv run pytest tests/unit/test_profile_catalog.py -x && \
uv run python -c "
from lokidoki.core.platform import detect_profile, PLATFORM_MODELS, FACE_RECOGNITION_DEFAULTS, HAILO_RUNTIME_REQUIREMENTS
profiles = set(PLATFORM_MODELS.keys())
expected = {'mac','windows','linux','pi_cpu','pi_hailo'}
assert profiles == expected, profiles ^ expected
required = {'llm_engine','llm_fast','llm_thinking','vision_model','object_detector_model','face_detector_model','stt_model','tts_voice','wake_word','image_gen_model','image_gen_lcm_lora','fast_keep_alive','thinking_keep_alive'}
for p, cfg in PLATFORM_MODELS.items():
    assert required <= set(cfg.keys()), f'{p} missing {required - set(cfg.keys())}'
    assert cfg['llm_engine'] in {'mlx','llama_cpp_vulkan','llama_cpp_cpu','hailo_ollama'}, cfg['llm_engine']
assert set(FACE_RECOGNITION_DEFAULTS.keys()) == expected
print('active profile:', detect_profile())
print('catalog OK —', len(PLATFORM_MODELS), 'profiles')
"
```

## Commit message

```
feat(platform): profile catalog with per-engine llm + full model fields

Replace the pi5/pi/mac/linux platform scheme with the five-profile
scheme from CLAUDE.md: mac (Apple Silicon only), windows, linux,
pi_cpu, pi_hailo. Each profile now carries an llm_engine field —
MLX on mac, llama.cpp (Vulkan) on windows+linux, llama.cpp (CPU) on
pi_cpu, hailo-ollama on pi_hailo. No stock Ollama anywhere.

PLATFORM_MODELS grows to 14 fields per profile covering every model
category (LLM, vision, STT, TTS, wake-word, image-gen, object +
face detectors). pi_cpu bumped from qwen3:1.7b to qwen3:4b on the
back of llama.cpp-direct RAM savings.

Intel Mac raises UnsupportedPlatform at detect_profile() — launcher
catches and prints a one-line message. No Gemma references remain
in code or AGENTS.md; the orchestrator routes via classifier +
skills + Qwen synthesis.

Refs docs/bootstrap_rewrite/PLAN.md chunk 1.
```

## Deferrals section (append as you discover)

- **Stale Gemma references in app code (cleanup deferred).** No `gemma_fallback.py` file exists, but inline references survive in `lokidoki/api/routes/dev.py` (status-page tile labelled "Gemma Fallback"), `lokidoki/orchestrator/fallbacks/ollama_client.py` (comments referencing `gemma` think-mode handling), `lokidoki/core/inference.py` (docstring + comments mention `gemma4`), and `lokidoki/orchestrator/core/config.py` (commented example `LOKI_LLM_MODEL=gemma4:e4b`). Per chunk action 10, cleanup is out of scope here — defer to a future chunk that touches the orchestrator/dev surfaces.
- **Cross-file rename collateral.** Action 5 mandated removing `detect_platform` and renaming the `platform` field to `profile`, which forced edits in two files outside the chunk's `## Files` list: `lokidoki/api/routes/chat.py` (two `_model_policy.platform` reads → `.profile`) and `tests/unit/test_model_manager.py` (rewritten for the new profile names + catalog keys + new `engine` property test). The legacy `tests/unit/test_platform.py` was deleted because every assertion targeted the now-removed `pi5`/`pi`/`detect_platform` API and `tests/unit/test_profile_catalog.py` covers its ground.
