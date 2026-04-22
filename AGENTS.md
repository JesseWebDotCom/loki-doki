# LokiDoki Agent Contract

Read [`docs/DESIGN.md`](docs/DESIGN.md) before any non-trivial work. If this file conflicts with `docs/DESIGN.md`, `docs/DESIGN.md` wins.

Detailed, area-specific guidance lives in [`.claude/rules/`](.claude/rules). Read the matching rule file before substantial work in that area.

## Project Snapshot

- Product name in UI/docs: **LokiDoki**
- Repo name: **loki-doki**
- Python package/import: **lokidoki**
- Core stack: FastAPI, React/Vite/Tailwind/shadcn, SQLite, profile-driven local Qwen engines
- Primary target: Raspberry Pi 5, with macOS for development
- Architecture: skills-first, local-first, offline-first

## Always-Apply Rules

- Use `./run.sh` and `run.bat` as entry points. Do not introduce alternate launch entry points.
- Keep platform behavior profile-driven: `mac`, `pi_cpu`, `pi_hailo`.
- STT, TTS, and wake word are CPU-only on every profile.
- Hailo is only for LLM and vision on `pi_hailo`, and every Hailo path needs a graceful CPU fallback.
- Never install dependencies from the agent shell. Add Python deps in `pyproject.toml`; add bootstrap-managed binaries, models, and tooling through `lokidoki/bootstrap/versions.py`, `lokidoki/bootstrap/steps.py`, `lokidoki/bootstrap/preflight/`, and `scripts/build_offline_bundle.py`.
- Never vendor third-party binaries, archives, weights, datasets, or dependency trees into the repo.
- Runtime must stay offline-first. No CDN assets, remote APIs, remote fonts, public map tiles, call-home telemetry, or runtime model downloads.
- Keep the three-repo split intact: core in `loki-doki`, optional integrations in `loki-doki-plugins`, persona content in `loki-doki-personas`.
- Do not use `bmo` as the project name.

## Working Style

- Inspect existing code and nearby working patterns before editing.
- Make the smallest complete fix. Include wiring, imports, registrations, and adjacent edits required for the feature to truly work.
- Do not invent new architecture, globals, wrappers, or APIs when the repo already has a pattern.
- Verify before claiming success.
- For non-trivial multi-session work, create a chunked plan under `docs/<plan-name>/` and follow the chunk contract from the docs rule file.
- Respect the active phase gate in `docs/PHASE_CURRENT.md`; do not scaffold a later phase early.

## Code Standards

- TDD first for new core logic or skill behavior: add a failing test in `tests/` before implementation.
- Keep files modular and single-purpose; split large files instead of extending them indefinitely.
- Use type hints on public Python functions and docstrings on public modules, classes, and functions.
- Use `pathlib`, `logging`, and specific exceptions; avoid `print` and bare `except`.
- Avoid import-time side effects.
- Do not classify user intent with regex or keyword heuristics; extend the decomposer’s structured output instead.
- Do not use `window.confirm`, `window.alert`, or `window.prompt` in the frontend. Use dialog components.
- Use pop-culture placeholders or generic names in tests and docs, never real personal names.

## Security

- Treat secret exposure as release-blocking.
- Never commit real credentials, tokens, JWT secrets, private keys, or machine-specific bootstrap config.
- Keep tracked examples as placeholders only, especially `.env.example` and `.pi.env.example`.
- Before finishing security-sensitive work, inspect changes touching `.env`, `.pi.env`, `.lokidoki/`, `data/`, or config files for leaks.

## Response Contract

Every final response should include:

1. Exact file(s) changed
2. Root cause
3. Applied change
4. Verification method
