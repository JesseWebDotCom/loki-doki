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
- **No Browser Dialogs**: NEVER use `window.confirm`, `window.alert`, or `window.prompt` (or their bare `confirm()` / `alert()` / `prompt()` forms) anywhere in the frontend. They are visually inconsistent with the Onyx Material system, cannot be styled, and break keyboard/focus flow inside our React tree. ALWAYS use a modal: `frontend/src/components/ui/ConfirmDialog.tsx` for confirmations, or build a `Dialog`-based component for inputs/alerts. If you find an existing `confirm()` / `alert()` / `prompt()` while editing nearby code, replace it.
- **No Regex/Keyword Classification of User Intent**: NEVER classify what the user *meant* using regex, keyword lists, or substring matches on `user_input`. That is the decomposer's job — it is a 2B LLM that already runs on every turn and emits structured fields (`intent`, `response_shape`, `overall_reasoning_complexity`, `short_term_memory.sentiment`, etc.). If downstream code needs a new branching signal — "is this a definitional query?", "is this an emotional turn?", "does this need synthesis?" — add a new field to `DecompositionResult` / `Ask`, teach the decomposer prompt + JSON schema to emit it, and branch on the structured field. Regex/keyword heuristics are a one-way ratchet toward unmaintainable rule piles: every edge case becomes another alternation, and they silently miss phrasings the LLM would handle correctly. Regex IS fine for parsing *machine-generated* text (HTML, JSON shapes, file paths) and for repair-loop salvage of malformed model output; it is NOT fine for understanding the user.

## Prompt Budget Discipline (Decomposer & Synthesis)
The decomposer runs on a small local model with a tight context window. Every token in the system prompt, schema, and examples is latency you pay on every single user turn. Follow these rules when touching `lokidoki/core/prompts/` or `DECOMPOSITION_SCHEMA`:

- **Budget ceiling**: The decomposition prompt (`DECOMPOSITION_PROMPT`) MUST stay under **8,000 chars**. A CI test enforces this — if you exceed it, shrink before merging. Measure with `len(DECOMPOSITION_PROMPT)`.
- **Derive, don't emit**: If a field's value is deterministically computable from other fields the model already emits, derive it in Python (`_build_ask` / `_derive_*`) instead of adding it to the JSON schema. Fewer schema fields = fewer constrained-decoder branches = faster inference.
- **Examples are expensive**: Each worked example is ~100-300 tokens. Before adding a new one, check whether an existing example already covers the routing pattern. Prefer compact key=value diffs over full JSON objects — list only non-default fields.
- **Rules are tokens**: Write rules as terse directives, not explanatory paragraphs. If a rule restates what the schema enum already says, delete it.
- **Schema field count**: Keep the ask schema under **12 required fields**. Every new required field multiplies constrained-decoding time.
- **Test the budget**: `tests/unit/test_decomposer.py` includes a prompt-size guard test. Update the ceiling constant there if intentional growth is justified (and document why in the commit).

## Technical Patterns
- Use `uv` for Python dependency management.
- Follow `docs/DESIGN.md` for architectural decisions.
- Maintain "Caveman" token compression for internal data flows.
- Ensure all skills follow the standardized manifest schema.
- Cite sources using `[src:N]` markers for fact-heavy responses.
