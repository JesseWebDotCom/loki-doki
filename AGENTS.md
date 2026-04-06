# LokiDoki Core — Agent Rules

## Project Context
LokiDoki is a private, local AI assistant for Raspberry Pi 5. It uses a "Skills-First, LLM-Last" architecture.
- **Backend**: FastAPI (Python), `uv` (dependency management), Ollama (Gemma 2B/9B).
- **Frontend**: React (Vite), Tailwind CSS, shadcn/ui.
- **Core Loop**: Decomposition (2B) -> Parallel Skills -> Synthesis (9B).
- **Locations**: `docs/`, `lokidoki/` (app), `assets/` (models/ui), `data/` (runtime).

## Approach
- **Think Before Acting**: Read existing files (especially `docs/DESIGN.md`) before writing code.
- **Be Concise**: Thorough reasoning, but dense and direct output.
- **Incremental Edits**: Prefer surgical `replace_file_content` over full file rewrites.
- **Atomic Operations**: Only re-read files if they've changed.
- **Self-Verification**: Test code/paths before asserting success.
- **No Fluff**: No sycophantic openers, apologies, or closing pleasantries.
- **Smallest Change**: Implement the most direct solution that solves the issue.
- **User Instructions Overrules**: User prompt always takes precedence over this file.

## Technical Patterns
- Use `uv` for Python dependency management.
- Follow `docs/DESIGN.md` for architectural decisions.
- Maintain "Caveman" token compression for internal data flows.
- Ensure all skills follow the standardized manifest schema.
- Cite sources using `[src:N]` markers for fact-heavy responses.
