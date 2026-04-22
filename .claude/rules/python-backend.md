---
paths:
  - "lokidoki/**/*.py"
  - "scripts/**/*.py"
  - "tests/**/*.py"
---

# Python And Backend Rules

- For new core logic or skill behavior, write a failing test first in `tests/`.
- Follow PEP 8 and keep public Python APIs typed and documented.
- Prefer small, testable functions and single-responsibility modules. Split files that grow too broad.
- Separate business logic, persistence, transport/UI, and utilities.
- Use `pathlib`, `logging`, and specific exceptions; avoid import-time side effects.
- Do not classify user intent from raw user text with regex or keyword heuristics. Add structured decomposer signals instead.
- In tests, use pop-culture placeholders or generic names, not real people.
