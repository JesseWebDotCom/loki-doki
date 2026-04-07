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
- **shadcn/ui & Onyx Material Mandatory**: All web components MUST be built using `shadcn/ui` primitives and follow the **Onyx Material** design system (Elevation Level 1-4, Material Purple accents, Onyx foundations).
- **Modular Design**: Prefer small, single-responsibility files. If a file exceeds ~250 lines or covers multiple distinct duties, refactor it into smaller, logically grouped files IMMEDIATELY.
- **Be Concise**: Thorough reasoning, but dense and direct output.
- **Incremental Edits**: Prefer surgical `replace_file_content` over full file rewrites.
- **Atomic Operations**: Only re-read files if they've changed.
- **Self-Verification**: Test code/paths before asserting success.
- **No Fluff**: No sycophantic openers, apologies, or closing pleasantries.
- **Smallest Change**: Implement direct solutions that solve the issue.
- **User Instructions Overrules**: User prompt always takes precedence over this file.
- **No Regex/Keyword Classification of User Intent**: NEVER classify what the user *meant* using regex, keyword lists, or substring matches on `user_input`. That is the decomposer's job — it is a 2B LLM that already runs on every turn and emits structured fields (`intent`, `response_shape`, `overall_reasoning_complexity`, `short_term_memory.sentiment`, etc.). If downstream code needs a new branching signal — "is this a definitional query?", "is this an emotional turn?", "does this need synthesis?" — add a new field to `DecompositionResult` / `Ask`, teach the decomposer prompt + JSON schema to emit it, and branch on the structured field. Regex/keyword heuristics are a one-way ratchet toward unmaintainable rule piles: every edge case becomes another alternation, and they silently miss phrasings the LLM would handle correctly. Regex IS fine for parsing *machine-generated* text (HTML, JSON shapes, file paths) and for repair-loop salvage of malformed model output; it is NOT fine for understanding the user.

## Technical Patterns
- Use `uv` for Python dependency management.
- Follow `docs/DESIGN.md` for architectural decisions.
- Maintain "Caveman" token compression for internal data flows.
- Ensure all skills follow the standardized manifest schema.
- Cite sources using `[src:N]` markers for fact-heavy responses.
