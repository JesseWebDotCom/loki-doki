@AGENTS.md

# Claude Code Notes

- Keep this file small. Put only startup-critical guidance here.
- Put area-specific guidance in `.claude/rules/` with `paths:` frontmatter so it loads only when relevant.
- If instructions seem missing or contradictory, check `/memory` and trim the conflicting file instead of adding another overlapping rule.
- Prefer path-scoped rules over growing this file.
