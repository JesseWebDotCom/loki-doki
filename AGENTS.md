# LokiDoki Core — Agent Rules

## Project Context
LokiDoki is a local AI assistant for Raspberry Pi 5 (and mac for development). It uses a "Skills-First, LLM-Last" architecture.
- **Backend**: FastAPI, `uv`, Ollama (Gemma 2B/9B).
- **Frontend**: React (Vite), Tailwind, shadcn/ui.
- **Core Loop**: Decomposition (2B) -> Skills -> Synthesis (9B).
- **Files**: `docs/`, `lokidoki/` (app), `assets/`, `data/`.

## Approach
- **Think Before Acting**: Read existing files (especially `docs/DESIGN.md`) before writing code.
- **TDD First**: Always write a failing unit test in `tests/` before implementing new core logic or skill features.
- **shadcn/ui Mandatory**: All web components MUST be built using `shadcn/ui` primitives for consistency and accessible UI.
- **Modular Design**: Prefer small, single-responsibility files. If a file exceeds ~250 lines or covers multiple distinct duties, refactor it into smaller, logically grouped files IMMEDIATELY.
- **Be Concise**: Thorough reasoning, but dense and direct output.
- **Incremental Edits**: Prefer surgical `replace_file_content` over full file rewrites.
- **Atomic Operations**: Only re-read files if they've changed.
- **Self-Verification**: Test code/paths before asserting success.
- **No Fluff**: No sycophantic openers, apologies, or closing pleasantries.
- **Smallest Change**: Implement direct solutions that solve the issue.
- **User Instructions Overrules**: User prompt always takes precedence over this file.

## Technical Patterns
- Use `uv` for Python dependency management.
- Follow `docs/DESIGN.md` for architectural decisions.
- Maintain "Caveman" token compression for internal data flows.
- Ensure all skills follow the standardized manifest schema.
- Cite sources using `[src:N]` markers for fact-heavy responses.
