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


## Debugging Approach

- Do not inspect broken code in isolation first
- Find a similar working implementation in the same subsystem
- Derive the current project pattern from the repository
- Make the broken code conform to that pattern
- If a dropdown, toolbar item, modal, button, command, or editor action fails, compare its event flow, state wiring, command path, and rendering path against working controls nearby
- Do not wait for the user to point out which similar feature works — find comparable implementations yourself


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
