---
paths:
  - "lokidoki/orchestrator/decomposer/**/*.py"
  - "tests/unit/test_decomposer*.py"
  - "tests/integration/test_decomposer*.py"
---

# Decomposer And Prompt-Budget Rules

- Treat prompt budget as a product requirement, not cleanup work.
- Keep `DECOMPOSITION_PROMPT` under the enforced size ceiling from the tests.
- If a value can be derived deterministically in Python, derive it instead of adding a schema field.
- Prefer compact examples and reuse existing routing patterns before adding new prompt examples.
- If a rule duplicates what an enum or schema already constrains, delete the prose rule instead of expanding the prompt.
- When the schema grows, update tests only when the growth is intentional and justified.
