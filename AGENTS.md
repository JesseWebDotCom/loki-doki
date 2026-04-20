# LokiDoki — Agent Build Contract

Read `docs/spec.md` before any non-trivial work. This file is the enforcement layer. If this file conflicts with `docs/spec.md`, `docs/spec.md` wins.

---

## Project Context
LokiDoki is a local AI assistant for Raspberry Pi 5 (and mac for development). It uses a "Skills-First, LLM-Last" architecture.
- **Backend**: FastAPI, `uv`, Qwen LLMs via profile-specific engines (MLX on mac, llama.cpp on win/linux/pi_cpu, hailo-ollama on pi_hailo).
- **Frontend**: React (Vite), Tailwind, shadcn/ui.
- **Core Loop**: Decomposition (fast Qwen) -> Skills -> Synthesis (thinking Qwen).
- **Files**: `docs/`, `lokidoki/` (app), `assets/`, `data/`.

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
- Models and engines: see `lokidoki/core/platform.py::PLATFORM_MODELS` for the authoritative per-profile catalog.
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

- Entry points are `./run.sh` (mac/linux) and `run.bat` (windows) — not `run.py`, not `app/main.py`. The shell launchers probe for Python and delegate to `python -m lokidoki.bootstrap`.
- STT **never** routes to Hailo — CPU only, always
- TTS **never** routes to Hailo — CPU only, always
- Wake word **never** routes to Hailo — CPU only, always
- Hailo accelerates **LLM and vision only** on `pi_hailo`
- Every Hailo provider must have a CPU fallback
- Missing Hailo hardware or HEF files must fail gracefully, never crash
- No `setup.sh` — the browser bootstrap installer replaces it entirely
- No `systemd`/`launchd` setup during active development (Phase 10 only)
- Never manually copy files to Pi — use a sync script
- Do not replace bootstrap installer UI with a framework — plain HTML/CSS/JS only
- All platform behavior is profile-driven: `mac` / `pi_cpu` / `pi_hailo`
- Blacklist `hailo_pci` before using `hailo1x_pci`
- Validate Hailo in Phase 2 before building subsystems that depend on it
- **Never install dependencies directly.** No `pip install`, `uv pip install`, `uv add`, `npm install`, `npm i`, `pnpm add`, `yarn add`, `brew install`, `apt install`, `port install`, `cargo install`, `go install`, `curl | sh`, or any other package-manager invocation from the agent shell. Every runtime binary, Python package, Node package, model file, and system tool MUST be added through the bootstrap pipeline (`lokidoki/bootstrap/preflight/` + `lokidoki/bootstrap/versions.py` + `lokidoki/bootstrap/steps.py`) or through `pyproject.toml` + `scripts/build_offline_bundle.py`. Bootstrap is the single install surface — if the user doesn't have it, bootstrap installs it; if bootstrap can't install it, it's not a supported dependency yet.
- **Never vendor third-party artifacts into the repo.** Do not commit prebuilt binaries, compiled libraries (`.so`, `.dylib`, `.dll`, `.a`, `.exe`), JARs, WARs, wheels, `node_modules/`, tarballs, zips, model weights (`.gguf`, `.safetensors`, `.onnx`, `.hef`, `.bin`), datasets, font files from vendors, or vendored upstream source trees. If the choice is "check a precompiled binary into the repo" vs "have the bootstrap download or compile it at install time," bootstrap wins — always. The repo holds source + pins + install recipes; the bootstrap materializes the artifacts on the target machine (or reads them from the offline bundle). Exceptions are limited to tiny first-party assets the app itself ships (icons, LokiDoki UI images, sample persona JSON).
- **Offline-first at runtime — bootstrap is the only network boundary.** After `./run.sh` finishes, LokiDoki MUST run with the network cable unplugged. No CDN script tags, no CDN stylesheets, no remote web-font imports, no remote map-tile servers, no unsolicited analytics, no remote model APIs, no "call-home" telemetry, no remote icon fonts. Every asset the running app reaches for — JS, CSS, fonts, icons, map tiles, routing graphs, model weights, sample data — must resolve to a file bootstrap already placed on disk. If a new feature needs upstream data (map tiles, routing graph, TTS voices, reference corpus), add a bootstrap step that pulls it during install (and mirrors it into the offline bundle); do not have the runtime fetch it on demand.

---

## Core Repo Structure

```
run.sh / run.bat                # Layer 0 launchers — probe Python, exec Layer 1
lokidoki/
  bootstrap/                    # Layer 1 — stdlib http.server install wizard
    __main__.py                 # `python -m lokidoki.bootstrap` entry
    server.py                   # ThreadingHTTPServer, SSE event stream
    pipeline.py                 # ordered step runner with retry/skip
    steps.py                    # per-profile step specs
    versions.py                 # pinned runtime binary SHAs
    offline.py                  # sibling offline-bundle seeding
    preflight/                  # one file per toolchain (python, uv, node, ...)
    ui/                         # plain HTML/CSS/JS wizard (no framework)
  core/
    platform.py                 # PLATFORM_MODELS — per-profile model catalog
  ...                           # subsystems, orchestrator, skills, providers
scripts/
  build_offline_bundle.py       # pre-download every pinned artifact
  verify_offline_bundle.py      # sha256 + size check against manifest
  enforce_residency.py
  bench_llm_models.py
.pi.env.example
```

---

## Bootstrap Architecture

- Entry point is `./run.sh` (mac/linux) or `run.bat` (windows). `run.py` is not the entry point.
- All bootstrap logic lives under `lokidoki/bootstrap/`. The install wizard is plain HTML/CSS/JS at `lokidoki/bootstrap/ui/` — do not replace it with a framework.
- Model IDs live in `lokidoki/core/platform.py::PLATFORM_MODELS`. Runtime binary versions live in `lokidoki/bootstrap/versions.py`. Do not create a third location.
- Intel Macs are not supported. `detect_profile()` raises `UnsupportedPlatform`; the shell launcher exits with a one-line message.
- LLM engines: MLX on `mac`, llama.cpp (Vulkan) on `windows` + `linux`, llama.cpp (CPU ARM NEON) on `pi_cpu`, hailo-ollama on `pi_hailo`. No stock Ollama anywhere in the codebase.
- Offline installs: `scripts/build_offline_bundle.py` pre-downloads every pinned artifact + HF snapshot; the wizard auto-detects a sibling `lokidoki-offline-bundle/` directory (or `--offline-bundle=<path>`) and runs without network.

---

## Dependency Installation (Bootstrap-Only)

Bootstrap owns every install. The agent shell does not. This rule is absolute and has no "just this once" exemptions.

**Never run from the agent shell:**
- `pip install`, `pip3 install`, `uv pip install`, `uv add`, `uv tool install`, `pipx install`
- `npm install`, `npm i`, `npm ci`, `pnpm add`, `pnpm install`, `yarn add`, `yarn install`
- `brew install`, `brew reinstall`, `brew upgrade`
- `apt install`, `apt-get install`, `dpkg -i`
- `port install`, `cargo install`, `go install`, `gem install`
- `curl … | sh`, `curl … | bash`, `wget … | sh`, or any `sh`/`bash` piped remote installer
- `huggingface-cli download`, `hf download`, or other ad-hoc model pulls

**Where dependencies actually go:**
- **Python runtime packages** → `pyproject.toml` (managed by `uv`, resolved during bootstrap's `uv sync` step). Do NOT add them with `uv add` from your shell — edit `pyproject.toml` and let the bootstrap install it.
- **Runtime binaries** (llama.cpp, MLX engines, Piper, whisper.cpp, tippecanoe, Valhalla, Temurin JRE, etc.) → pinned in `lokidoki/bootstrap/versions.py` with an entry in `lokidoki/bootstrap/steps.py` and a preflight module in `lokidoki/bootstrap/preflight/<tool>.py`.
- **Frontend packages** → `frontend/package.json`, installed by the bootstrap's Node preflight step.
- **Model weights** → `lokidoki/core/platform.py::PLATFORM_MODELS`, downloaded by bootstrap into the configured model cache.
- **Offline mirror** → every pinned artifact must also be listed in `scripts/build_offline_bundle.py` so an offline Pi install stays reproducible.

**If a tool or package is missing during dev:**
1. Add/extend the preflight module under `lokidoki/bootstrap/preflight/` (one file per toolchain).
2. Pin its version + SHA in `lokidoki/bootstrap/versions.py`.
3. Wire it into `lokidoki/bootstrap/steps.py` for the relevant profile(s).
4. Add it to `scripts/build_offline_bundle.py`.
5. Re-run `./run.sh` (or `run.bat`) so the bootstrap pipeline installs it the correct way on your machine.

**Why:** end users install LokiDoki by running `./run.sh` once. If the agent installs a dependency out-of-band, the user's machine will never get it, CI will never get it, the Pi image will never get it, and the offline bundle will silently be missing it. Every "quick" manual install is a time bomb for the install wizard. The only correct install is a bootstrap install.

### No Vendored Third-Party Artifacts

The repo is source + pins + install recipes. It is NOT a binary distribution channel. Third-party artifacts get materialized at install time by the bootstrap — either downloaded from a pinned upstream release or compiled locally from pinned source.

**Never check into the repo:**
- Prebuilt binaries or executables (`.exe`, Mach-O, ELF, static binaries with no extension)
- Compiled native libraries (`.so`, `.dylib`, `.dll`, `.a`, `.lib`)
- Language-ecosystem build outputs (`.jar`, `.war`, `.whl`, `.egg`, `.deb`, `.rpm`, `.pkg`, `.dmg`, `.msi`)
- Installed dependency trees (`node_modules/`, `.venv/`, `vendor/`, `target/`, `site-packages/`)
- Upstream source trees vendored into our tree (git-subtree / copy-paste of other projects' code)
- Tarballs / zips / archives of upstream releases (`.tar.gz`, `.tgz`, `.zip`, `.7z`)
- Model weights of any kind (`.gguf`, `.safetensors`, `.onnx`, `.hef`, `.pt`, `.ckpt`, `.bin` weight files)
- Voice models, wake-word models, STT/TTS weights, speaker-embedding files
- Datasets, corpora, large CSV/Parquet reference files

**The binary-vendoring decision rule:** when the choice is "commit a precompiled binary into the repo" vs "have the bootstrap download it (or compile it from pinned source)," bootstrap wins every time. No exceptions for convenience, CI speed, or "it's only 2 MB."

**How bootstrap materializes a third-party artifact:**
1. **Download path** — preflight fetches a pinned release URL, verifies the `sha256` from `versions.py`, and extracts it into the user's bootstrap-managed tool directory.
2. **Compile path** — preflight clones a pinned source tag, runs a pinned build command, and installs the output into the tool directory. Use this when upstream does not ship a prebuilt for our profile (common for `pi_cpu` / `pi_hailo`).
3. **Offline path** — `scripts/build_offline_bundle.py` stages the same artifact into the sibling `lokidoki-offline-bundle/` so an air-gapped Pi gets the identical file.

**The only things that may live in the repo:**
- First-party source we wrote (Python, TS, HTML, CSS, shell).
- Small first-party UI assets the app itself ships (`assets/` icons, LokiDoki logos, sample persona JSON content).
- Configuration, manifests, and pin files (`pyproject.toml`, `package.json`, `versions.py`, `PLATFORM_MODELS`).
- Docs and tests.

If you find yourself typing `git add` on a binary, stop. The answer is a preflight module plus a `versions.py` entry, not a checked-in file.

### Offline-First Runtime (Network Boundary = Bootstrap Only)

LokiDoki runs on a Raspberry Pi that may be deployed in homes, vehicles, boats, RVs, off-grid cabins, or air-gapped environments. **The running app must function with the network cable unplugged.** Bootstrap is the one-and-only moment network access is permitted — and even that is optional when an offline bundle is present.

**Never ship runtime code that reaches out to:**
- CDN `<script src>` / `<link href>` tags (unpkg, jsdelivr, cdnjs, Google Fonts, cloudflare, etc.)
- Remote web-font providers (`fonts.googleapis.com`, Adobe Fonts, Typekit, Bunny Fonts)
- Remote icon fonts (Font Awesome CDN, Material Icons via Google Fonts)
- Remote map-tile servers (OpenStreetMap public tile server, Mapbox, Stadia, Stamen, Thunderforest, Carto)
- Remote routing / geocoding APIs (Mapbox Directions, Google Maps, Nominatim public instance, OpenRouteService public)
- Remote model APIs (OpenAI, Anthropic, Google, Groq, Together, Replicate, HuggingFace Inference API)
- Remote speech services (Google STT/TTS, Azure Speech, AWS Polly, ElevenLabs)
- Remote analytics / telemetry / error reporting (Segment, Mixpanel, PostHog cloud, Sentry cloud)
- Cloud storage or databases (S3, GCS, Firebase, Supabase cloud) for core data paths
- Auto-update checks that call a remote server on launch

**Positive rule — every runtime asset resolves to a local file:**
- JS / CSS → bundled by Vite into our own `frontend/dist/` and served by FastAPI.
- Fonts → checked into `assets/fonts/` (first-party) or downloaded by bootstrap into the app's asset directory; served locally, `@font-face` with local URLs only.
- Icons → `lucide-react` (bundled) or local SVG; never a CDN icon font.
- Map tiles → bootstrap downloads the user's region as `.mbtiles` / `.pmtiles`; runtime reads from that file via a local tile server we run ourselves.
- Routing graph → bootstrap builds/downloads the Valhalla tiles for the user's region into a local directory; runtime queries our local Valhalla sidecar.
- LLM / vision / STT / TTS / wake-word weights → downloaded by bootstrap per `PLATFORM_MODELS` / `versions.py`; runtime loads from disk.
- Reference data (Wikipedia snapshots, docs corpora, etc.) → same pattern: bootstrap pulls, runtime reads local.

**Decision rule for new features that "just need to fetch X":**
1. Does the user's machine need X to use the feature? → Then bootstrap must install X.
2. Is X region-specific or user-specific (maps, routing, persona)? → The wizard asks during install and bootstrap fetches the right subset.
3. Is X too large to ship by default? → Make it an optional bootstrap step (checkbox in the wizard), not a runtime download.
4. Does X update often and the user wants fresh data? → Add an explicit, user-initiated "Update X" action that re-runs the bootstrap step for X. Never auto-fetch at app startup or on first use.

**The map-tiles lesson:** the first pass of map functionality used a public tile CDN at runtime. That is a violation — it breaks offline, leaks the user's viewing activity to a third party, and makes the Pi-in-an-RV use case impossible. The correct shape is: bootstrap asks the user for their region, downloads `.pmtiles` for that region, installs a local tile server, and the frontend points at the local server. Apply the same reasoning to every future feature before writing the first line.

**When you're unsure:** assume offline. Design the feature to work with the network unplugged, then decide which preflight step materializes the data. Retrofitting offline support is always harder than designing for it up front.

---

## Request Path

```
[STT] → [Classifier] → [Router] → [Skill Handlers | fast Qwen | thinking Qwen] → [TTS]
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

---

## What Goes Where

**Core (`loki-doki`):** text, image, video, live_video, voice, memory, persona, orchestrator, classifier, bootstrap, UI

**Plugins (`loki-doki-plugins`, optional):** home_automation, calendar, weather, system, web, notifications, media

**Personas (`loki-doki-personas`, content only):** assets + persona.json + prompt config — no code, no API calls

---

## Approach
- **Think Before Acting**: Read existing files (especially `docs/DESIGN.md`) before writing code.
- **TDD First**: Always write a failing unit test in `tests/` before implementing new core logic or skill features.
- **shadcn/ui & Onyx Material Mandatory**: All web components MUST be built using `shadcn/ui` primitives and follow the **Onyx Material** design system (Elevation Level 1-4, Material Purple accents, Onyx foundations).
- **Modular Design**: Prefer small, single-responsibility files. If a file exceeds ~250 lines or covers multiple distinct duties, refactor it into smaller, logically grouped files IMMEDIATELY.
- **Be Concise**: Thorough reasoning, but dense and direct output.
- **Incremental Edits**: Prefer surgical `replace_file_content` over full file rewrites.
- **Atomic Operations**: Only re-read files if they've changed.
- **Self-Verification**: Test code/paths before asserting success.
- **No Fluff**: No sycophantic openers, apologies, or closing pleasantries.
- **Smallest Change**: Implement direct solutions that solve the issue.
- **User Instructions Overrules**: User prompt always takes precedence over this file.
- **No Browser Dialogs**: NEVER use `window.confirm`, `window.alert`, or `window.prompt` (or their bare `confirm()` / `alert()` / `prompt()` forms) anywhere in the frontend. They are visually inconsistent with the Onyx Material system, cannot be styled, and break keyboard/focus flow inside our React tree. ALWAYS use a modal: `frontend/src/components/ui/ConfirmDialog.tsx` for confirmations, or build a `Dialog`-based component for inputs/alerts. If you find an existing `confirm()` / `alert()` / `prompt()` while editing nearby code, replace it.
- **No Regex/Keyword Classification of User Intent**: NEVER classify what the user *meant* using regex, keyword lists, or substring matches on `user_input`. That is the decomposer's job — it is a 2B LLM that already runs on every turn and emits structured fields (`intent`, `response_shape`, `overall_reasoning_complexity`, `short_term_memory.sentiment`, etc.). If downstream code needs a new branching signal — "is this a definitional query?", "is this an emotional turn?", "does this need synthesis?" — add a new field to `DecompositionResult` / `Ask`, teach the decomposer prompt + JSON schema to emit it, and branch on the structured field. Regex/keyword heuristics are a one-way ratchet toward unmaintainable rule piles: every edge case becomes another alternation, and they silently miss phrasings the LLM would handle correctly. Regex IS fine for parsing *machine-generated* text (HTML, JSON shapes, file paths) and for repair-loop salvage of malformed model output; it is NOT fine for understanding the user.

---

## Prompt Budget Discipline (Decomposer & Synthesis)
The decomposer runs on a small local model with a tight context window. Every token in the system prompt, schema, and examples is latency you pay on every single user turn. Follow these rules when touching `lokidoki/core/prompts/` or `DECOMPOSITION_SCHEMA`:

- **Budget ceiling**: The decomposition prompt (`DECOMPOSITION_PROMPT`) MUST stay under **8,000 chars**. A CI test enforces this — if you exceed it, shrink before merging. Measure with `len(DECOMPOSITION_PROMPT)`.
- **Derive, don't emit**: If a field's value is deterministically computable from other fields the model already emits, derive it in Python (`_build_ask` / `_derive_*`) instead of adding it to the JSON schema. Fewer schema fields = fewer constrained-decoder branches = faster inference.
- **Examples are expensive**: Each worked example is ~100-300 tokens. Before adding a new one, check whether an existing example already covers the routing pattern. Prefer compact key=value diffs over full JSON objects — list only non-default fields.
- **Rules are tokens**: Write rules as terse directives, not explanatory paragraphs. If a rule restates what the schema enum already says, delete it.
- **Schema field count**: Keep the ask schema under **12 required fields**. Every new required field multiplies constrained-decoding time.
- **Test the budget**: `tests/unit/test_decomposer.py` includes a prompt-size guard test. Update the ceiling constant there if intentional growth is justified (and document why in the commit).

---

## Coding Rules

- PEP 8, type hints on public functions, docstrings on public modules/classes/functions
- Files under 300 lines, functions under 40 lines — split before appending
- One responsibility per file
- Use `pathlib`, `logging` (not print), specific exceptions (no bare except)
- No side effects at import time
- Separate business logic, persistence, API/UI, and utilities
- Prefer small, testable functions and dataclasses/typed models for structured data
- **Test Data Mocking**: Never use real family, friend, or personal names in tests, documentation, or system prompts. Always use pop culture characters (e.g., Luke, Anakin, Leia, Padme) or generic placeholders.

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

## Technical Patterns
- Use `uv` for Python dependency management.
- Follow `docs/DESIGN.md` for architectural decisions.
- Maintain "Caveman" token compression for internal data flows.
- Ensure all skills follow the standardized manifest schema.
- Cite sources using `[src:N]` markers for fact-heavy responses.

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

## Chunked Plan Pattern (Non-Trivial Work)

Any plan large enough to span multiple sessions — rewrites, subsystem rewires, multi-file refactors, multi-step features — MUST be authored as a chunked plan under `docs/<plan-name>/`. Small, self-contained tasks (a bug fix, a one-file change, a doc tweak) do NOT need chunking — just do them. The reference implementations are `docs/bootstrap_rewrite/` (9 chunks) and `docs/memory_unify/` (7 chunks) in history — study those before authoring a new one.

**Why this pattern exists:** each chunk runs in a fresh Claude Code session. The point is to keep the context window small per execution — no prior chunks, no prior turns, no accumulated scroll. Minimal tokens per chunk = lower latency, lower cost, better focus. If a plan can fit in one session without blowing context, don't chunk it.

### When to chunk

- **Chunk it** if the work touches >5 files across >1 subsystem, requires >1 commit, or spans >1 phase-gate checklist item.
- **Do not chunk** a typo fix, a single-file bug, a CSS tweak, a prompt-budget shrink, or anything you'd normally PR as a single commit.
- When in doubt, chunk — over-chunking wastes authoring time; under-chunking blows context and forces mid-work compression.

### Directory layout

```
docs/<plan-name>/
  PLAN.md                       # index + operating contract + global context
  chunk-1-<slug>.md             # one file per chunk, numbered 1..N
  chunk-2-<slug>.md
  ...
```

### `PLAN.md` structure (required sections, in order)

1. **Title + one-paragraph goal** — what ships when every chunk is `done`.
2. **How to use this document (operating contract)** — the fixed block copied verbatim from `docs/bootstrap_rewrite/PLAN.md`. Pick first `pending` chunk → announce which chunk you are starting → read ONLY that chunk doc → execute `## Actions` → run `## Verify` → commit per `## Commit message` → flip row to `done` + paste SHA → announce which chunk you processed + the commit SHA → **STOP. Do not begin the next chunk in the same session.**
3. **Status table** — `| # | Chunk | Status | Commit |` with rows linking to each chunk doc. Statuses: `pending`, `done`, or the literal text of a blocker.
4. **Global context** — facts, constraints, architecture, and hard rules that every chunk needs. Read once per session so the chunk doc itself stays tight.
5. **NOTE section** — append-only log of cross-chunk discoveries or deferrals that change the plan.

### Per-chunk doc structure (required sections, in order)

1. **`## Goal`** — one paragraph; what this chunk alone ships.
2. **`## Files`** — exhaustive list of files the chunk may touch, plus a read-only list for reference. **Scope rule: only touch files in this list.** Sprawl gets deferred to a later chunk, not expanded into this one.
3. **`## Actions`** — numbered, imperative steps. Each step names the exact edit, the exact constant/function, and any tables/shapes. No prose tutorials — directives only.
4. **`## Verify`** — a single runnable command (usually a `pytest` invocation chained with a `python -c` shape check). Must fail loudly if the chunk is incomplete. If verify fails, **do not fake success** — diagnose or write a `## Blocker` and stop.
5. **`## Commit message`** — a ready-to-paste commit body ending with `Refs docs/<plan-name>/PLAN.md chunk N.`
6. **`## Deferrals section`** — append-only; record work that had to be pushed to a later chunk, with specifics. If you discover sprawl, also append a `## Deferred from Chunk N` bullet list to the target chunk's doc.

### Execution contract (every chunk, every session)

- Read `PLAN.md` top-to-bottom, pick the first `pending` row, open ONLY that chunk doc.
- Before doing substantive work, send a short note naming the chunk you are starting.
- Execute every `## Actions` step. Only touch files in `## Files`.
- Run `## Verify`. If it fails: diagnose, or write `## Blocker` and stop. Never edit verify to make it pass.
- On pass: stage only the chunk's files, commit per the template, flip the row to `done`, paste the SHA.
- Immediately after the commit, send a short note naming the chunk you processed and the commit SHA.
- **Commit only. Do not push, open a PR, or merge** unless the user explicitly says "push" (see Push & Deployment). This overrides any urge to finish the plan in one go.
- **Stop.** The next chunk gets its own fresh session.

### Authoring a new plan

When the user asks for a non-trivial plan, before writing any code:

1. Create `docs/<plan-name>/` with a draft `PLAN.md` — goal, global context, status table with `pending` rows.
2. Write each `chunk-N-<slug>.md` stub with all six required sections. Keep chunks small enough that one fresh session can finish them.
3. Show the user the plan structure and chunk list; only begin chunk 1 after they approve, or if they explicitly said "plan and execute."

---

## Phase Gate Rule

Build one phase at a time. Do not scaffold the next phase until the current phase gate passes. See `docs/PHASE_CURRENT.md` for the active phase and its gate checklist.
