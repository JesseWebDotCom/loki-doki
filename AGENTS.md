# LokiDoki — Agent Build Contract

Read `docs/spec.md` before any non-trivial work. This file is the enforcement layer. If this file conflicts with `docs/spec.md`, `docs/spec.md` wins.

---

## Naming

- Display/UI/docs: **LokiDoki**
- GitHub repo: **loki-doki**
- Python package/import name: **lokidoki**
- Do not use `bmo` as the project name

---

## Stack

- Backend: **FastAPI** (control plane, internal API, serves React bundle)
- Frontend: **React + Vite + Tailwind + shadcn/ui + Lucide**
- Database: **SQLite** (users, memory, settings)
- Auth: **FastAPI + JWT** (no external user system)
- LLM chat (mac/pi_cpu): **Qwen via Ollama** — non-thinking (fast) and thinking (reasoning) modes
- LLM chat (pi_hailo): **Qwen via hailo-ollama** on port 8000
- Function model: **Gemma (~270M, function-calling fine-tune)** via Ollama — tool/API execution only
- STT: **provider-swappable** — `faster-whisper` (default) or `whisper.cpp`; CPU only, all profiles
- TTS: **Piper medium model** on CPU only, all profiles
- Wake word: **openWakeWord** on CPU only, all profiles

---

## Repository Boundaries (Three-Repo Split — Never Collapse)

1. `loki-doki` — core platform only
2. `loki-doki-plugins` — optional plugins only
3. `loki-doki-personas` — persona content only (no API calls, no device control)

---

## Absolute Hard Rules

- `run.py` is the only user entry point — never tell users to run `app/main.py`
- STT **never** routes to Hailo — CPU only, always
- TTS **never** routes to Hailo — CPU only, always
- Wake word **never** routes to Hailo — CPU only, always
- Hailo accelerates **LLM and vision only** on `pi_hailo`
- Every Hailo provider must have a CPU fallback
- Missing Hailo hardware or HEF files must fail gracefully, never crash
- No `setup.sh` — the browser bootstrap installer replaces it entirely
- No `systemd`/`launchd` setup during active development (Phase 10 only)
- Never manually copy files to Pi — use `scripts/sync_to_pi.sh`
- Do not replace bootstrap installer UI with a framework — plain HTML/CSS/JS only
- All platform behavior is profile-driven: `mac` / `pi_cpu` / `pi_hailo`
- Blacklist `hailo_pci` before using `hailo1x_pci`
- Validate Hailo in Phase 2 before building subsystems that depend on it

---

## Core Repo Structure

```
run.py                    # single entry point
app/
  main.py
  config.py
  orchestrator.py
  classifier.py
  bootstrap/
    server.py             # stdlib http.server, zero deps
    installer.py
    health.py
    static/               # plain HTML/CSS/JS installer UI
  ui/                     # React app (built by Vite, served by FastAPI)
  platform/
    mac/audio.py
    pi/audio.py
  subsystems/
    text/  image/  video/  live_video/  voice/  memory/  persona/
  providers/
  settings/
scripts/
  sync_to_pi.sh
  run_on_pi.sh
  pi_log.sh
.pi.env.example
```

---

## Request Path

```
[STT] → [Router] → fast Qwen / thinking Qwen / Gemma function model → [Tools/APIs] → [TTS]
```

Full pipeline:
```
input → classifier → route → subsystem / plugin / provider → response
```

- Classifier runs first — do not send every request to the full LLM
- Router decides between three paths (prompt-based, no training required):
  - `simple_query` → canned response, no LLM
  - `text_chat` easy → fast Qwen (non-thinking mode)
  - `text_chat` hard → thinking Qwen (reasoning mode)
  - `tool_call` → Gemma function model → executes tool → result back to Qwen for final response

---

## What Goes Where

**Core (`loki-doki`):** text, image, video, live_video, voice, memory, persona, orchestrator, classifier, bootstrap, UI

**Plugins (`loki-doki-plugins`, optional):** home_automation, calendar, weather, system, web, notifications, media

**Personas (`loki-doki-personas`, content only):** assets + persona.json + prompt config — no code, no API calls

---

## Coding Rules

- PEP 8, type hints on public functions, docstrings on public modules/classes/functions
- Files under 300 lines, functions under 40 lines — split before appending
- One responsibility per file
- Use `pathlib`, `logging` (not print), specific exceptions (no bare except)
- No side effects at import time
- Separate business logic, persistence, API/UI, and utilities
- Prefer small, testable functions and dataclasses/typed models for structured data

---

## Agent Behavior Rules

- Operate as if in agent mode — apply fixes immediately, do not describe them
- Make all required edits across all required files in the same response
- Do not output "next steps," do not ask "Would you like me to…"
- Treat the repository as the source of truth
- When fixing a bug: find the actual cause, compare to nearby working code, follow the existing pattern
- Make the smallest change that fully solves the problem
- Include all required imports, registrations, and wiring
- State exactly what changed, in which files, and how to verify

---

## Phase Gate Rule

Build one phase at a time. Do not scaffold the next phase until the current phase gate passes. See `docs/PHASE_CURRENT.md` for the active phase and its gate checklist.
