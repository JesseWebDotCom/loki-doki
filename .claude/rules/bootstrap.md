---
paths:
  - "run.sh"
  - "run.bat"
  - ".pi.env.example"
  - "lokidoki/bootstrap/**/*"
  - "lokidoki/core/platform.py"
  - "scripts/build_offline_bundle.py"
  - "scripts/verify_offline_bundle.py"
  - "scripts/enforce_residency.py"
  - "scripts/bench_llm_models.py"
---

# Bootstrap And Platform Rules

- Bootstrap is the only supported install surface. Do not solve missing tooling with ad-hoc shell installs.
- Keep model IDs authoritative in `lokidoki/core/platform.py::PLATFORM_MODELS` and runtime binary pins in `lokidoki/bootstrap/versions.py`. Do not create a third source of truth.
- Bootstrap UI must stay plain HTML/CSS/JS under `lokidoki/bootstrap/ui/`; do not replace it with a framework.
- Intel Macs are unsupported. Preserve graceful failure in profile detection and launch messaging.
- No stock Ollama anywhere in the codebase. Engine selection stays profile-specific: MLX on `mac`, llama.cpp on `windows`/`linux`/`pi_cpu`, hailo-ollama on `pi_hailo`.
- Missing Hailo hardware or HEF files must fail gracefully, never crash.
- Never manually copy files to Pi; use a sync script or bootstrap/offline-bundle flow.
- Keep offline installs reproducible: every pinned runtime artifact added here must also be staged by `scripts/build_offline_bundle.py`.
