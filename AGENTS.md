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

## Security Rules

- Treat secret exposure as a release-blocking bug
- Never commit real usernames, passwords, tokens, JWT secrets, private keys, or device-specific bootstrap config
- Use placeholders in tracked examples: `.env.example` and `.pi.env.example`
- Keep real bootstrap credentials only in ignored local files or interactive setup flows — never in tracked JSON or source files
- Before finishing any security-sensitive work, inspect staged changes for secrets and blocked files: `app_config.json`, `.env`, `.pi.env`, `.lokidoki/`, and `data/`

---

## Agent Behavior Rules

- Operate as if in agent mode — apply fixes immediately, do not describe them
- Make all required edits across all required files in the same response
- Do not output "next steps," do not ask "Would you like me to…", do not say "Would you like me to update that too?"
- Treat the repository as the source of truth
- Learn how the application works from the code before making claims
- Trace behavior across files, imports, components, handlers, state, templates, routes, and APIs
- Never debug code in isolation when similar working code exists nearby
- Do not invent new APIs, globals, wrappers, or architecture unless the repo already uses them
- Do not say something "may be in another file" unless you traced evidence
- Make the smallest change that fully solves the problem
- Include all required imports, registrations, and wiring
- If multiple obvious edits are required, make all of them

---

## Debugging Approach

- Do not inspect broken code in isolation first
- Find a similar working implementation in the same subsystem
- Derive the current project pattern from the repository
- Make the broken code conform to that pattern
- If a dropdown, toolbar item, modal, button, command, or editor action fails, compare its event flow, state wiring, command path, and rendering path against working controls nearby
- Do not wait for the user to point out which similar feature works — find comparable implementations yourself

---

## Editor Rules

The editor has both modern Lexical-based code and older legacy code. Do not assume new editor functionality should follow the legacy path.

When making editor changes:
- First identify whether the affected behavior belongs to the Lexical editor flow or the legacy DOM/JS flow
- If a similar editor control already works, use that working control as the primary reference
- Prefer the existing Lexical command/update/plugin/state pattern over direct DOM manipulation
- Do not introduce new window-level editor APIs unless that pattern already exists in the repository
- If a new dropdown, toolbar item, or insert action is broken, compare it directly to other working editor controls and make it follow the same command and update path
- Avoid mixing legacy DOM mutation code into Lexical-driven behavior unless the repository already does so intentionally

## Editor Build & Cache Busting

After every change to editor frontend code, also update the editor asset version in `app/main.py` so the latest JS and CSS are loaded:
- If `frontend/editor/main.tsx` or related editor frontend assets change, bump the asset version for `editor2.js` and `editor2.css` in `app/main.py`
- Do not leave editor asset versions unchanged after editor frontend edits
- Treat cache busting as part of the implementation, not an optional follow-up step

---

## Output Format

Every response must follow this structure:

1. Exact file(s) changed
2. Root cause (one sentence)
3. The applied change or diff
4. Verification method (specific, not generic)

**Bad response:**
- "Next steps: apply the patch, rebuild, reload."
- "Would you like me to update that too?"
- "This may be in another file or legacy code."
- "Here's the fix you can apply…" — apply it, don't present it

**Good response:**
- "Updated `frontend/editor/...` and `app/main.py`."
- "The broken dropdown was using a different pattern than nearby working Lexical controls."
- "Changed it to follow the same command/update flow as the working controls."
- "Bumped editor asset versions so the new bundle is loaded."

---

## Push & Deployment

Whenever the user says "push" or "push our changes":

1. **Do not push directly to `main`** — it is protected by status checks (e.g. `gitleaks`)
2. Automate the full PR flow:
   - Create a new feature branch: `feature/push-[timestamp]`
   - Push the branch to `origin`
   - Create a Pull Request: `gh pr create`
   - Approve the Pull Request: `gh pr approve`
   - Merge the Pull Request: `gh pr merge --merge --delete-branch`
   - Switch back to `main` and run `git pull origin main`
3. Perform this entire sequence automatically without asking for permission
4. If any step fails (e.g. required checks haven't passed), inform the user and provide the PR link

---

## Phase Gate Rule

Build one phase at a time. Do not scaffold the next phase until the current phase gate passes. See `docs/PHASE_CURRENT.md` for the active phase and its gate checklist.
