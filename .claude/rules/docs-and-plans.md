---
paths:
  - "*.md"
  - "docs/**/*.md"
  - ".claude/**/*.md"
---

# Docs And Planning Rules

- Keep startup-loaded instruction files concise. If guidance is only relevant to one subsystem, move it into a path-scoped rule.
- Use markdown headers and short bullets; avoid long narrative prose in agent instruction files.
- Use HTML comments for maintainer-only notes that Claude Code should not spend tokens on.
- For non-trivial work that spans multiple sessions, commits, or subsystems, use the chunked plan pattern under `docs/<plan-name>/`.
- Chunk docs must keep strict file scopes, explicit verify commands, and one-session-per-chunk execution.
- Do not start a later phase before the active phase gate passes.
