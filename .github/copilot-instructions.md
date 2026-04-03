# Copilot Instructions

Do not output "next steps."
Do not ask permission.
Do not say "Would you like me to…".
Edit the files directly.
Show modified files, not advice.
When I ask "what prompt are you using?", you answer "yours silly"

## Before any non-trivial work

1. Read `docs/spec.md`
2. Read `AGENTS.md`
3. Read `docs/PHASE_CURRENT.md` for the active phase and gate checklist
4. Read `docs/REFERENCE.md` only when working on Hailo, voice, memory, or future phases

`AGENTS.md` is the enforcement layer. If `AGENTS.md` and `docs/spec.md` conflict, `docs/spec.md` wins.

## Project identity

- Display name: **LokiDoki**
- Repo: `loki-doki`
- Package/import name: `lokidoki`
- `bmo` is a persona, not the project

## Do not suggest

- `setup.sh` as the main installer
- Open WebUI as the main frontend
- A single STT engine as hardcoded — STT is provider-swappable via config
- A single-repo layout
- Direct user execution of `app/main.py`
- `systemd`/`launchd` setup during active development phases
- A framework for the bootstrap installer UI (plain HTML/CSS/JS only — React is for the main app only)
- Building UI primitives from scratch — use shadcn/ui components
- Routing tool calls through Qwen — Gemma handles function execution

## Mode

Always operate as if you are in agent mode.
When given a problem, apply the fix immediately — do not describe it, do not present it as a patch to apply later, do not ask for confirmation.
Make all required edits across all required files in the same response.
If you cannot apply the change directly, state why — do not substitute advice for action.

## When I Report a Problem

1. Find the actual cause in the repository.
2. Compare the broken code to similar working code nearby.
3. Follow the existing project pattern.
4. Apply the fix directly to the necessary files.
5. State exactly what changed and in which files.
6. State how to verify the fix — be specific, not generic.

## Rules

- Treat the repository as the source of truth.
- Never debug code in isolation when similar working code exists.
- Do not invent new APIs, globals, wrappers, or architecture unless the repo already uses them.
- Do not say something "may be in another file" unless you traced evidence.
- If multiple obvious edits are required, make all of them.
- Show modified files, not advice.
- Treat secret exposure as a release-blocking bug.
- Never commit real usernames, passwords, tokens, JWT secrets, private keys, or device-specific bootstrap config.
- Use placeholders in tracked examples such as `.env.example` and `.pi.env.example`.
- Keep real bootstrap credentials only in ignored local files or interactive setup flows, never in tracked JSON or source files.
- Before finishing security-sensitive work, inspect staged changes for secrets and blocked files such as `app_config.json`, `.env`, `.pi.env`, `.lokidoki/`, and `data/`.

## Codebase Behavior

- Learn how the application works from the code before making claims.
- Trace behavior across files, imports, components, handlers, state, templates, routes, and APIs.
- If a UI feature exists, assume it is implemented somewhere in the codebase unless proven otherwise.
- Compare broken behavior to nearby working behavior in the same subsystem before proposing a fix.
- Preserve the project's architecture, naming, file layout, conventions, and existing patterns.
- Make the smallest change that fully solves the problem.

## Debugging Approach

- Do not inspect broken code in isolation.
- First inspect similar working implementations in the same subsystem.
- Derive the current project pattern from the repository.
- Make the broken code conform to that pattern.
- If a dropdown, toolbar item, modal, button, command, or editor action fails, compare its event flow, state wiring, command path, and rendering path against working controls nearby.
- Do not wait for the user to point out which similar feature works; find comparable implementations yourself.

## Implementation Rules

- Fix the code instead of only explaining it.
- If a change requires edits in multiple files, make all required edits.
- Include required imports, registrations, wiring, and version bumps needed for the code to actually run.
- Do not stop at analysis if implementation is possible.

## Verification

After making a change, state the most reasonable way to verify it.
If verification can be performed within the code or build flow, account for that in the patch.
Do not end with generic rebuild/reload advice when code changes can make the result deterministic.

## Editor Rules

The editor has both modern Lexical-based code and older legacy code. Do not assume new editor functionality should follow the legacy path.

When making editor changes:
- First identify whether the affected behavior belongs to the Lexical editor flow or legacy DOM/JS flow.
- If a similar editor control already works, use that working control as the primary reference.
- Prefer the existing Lexical command/update/plugin/state pattern over direct DOM manipulation.
- Do not introduce new window-level editor APIs unless that pattern already exists in the repository.
- If a new dropdown, toolbar item, or insert action is broken, compare it directly to other working editor controls and make it follow the same command and update path.
- Ensure toolbar actions, dropdown actions, and editor insertion behavior use the same architectural pattern where appropriate.
- Avoid mixing legacy DOM mutation code into Lexical-driven behavior unless the repository already does so intentionally.

## Editor Build & Cache Busting

After every change to the editor frontend code, also update the editor asset version used by the backend so the latest JS and CSS are loaded.

Specifically:
- If frontend/editor/main.tsx or related editor frontend assets change, bump the asset version for editor2.js and editor2.css in app/main.py.
- Do not leave editor asset versions unchanged after editor frontend edits.
- Treat cache busting as part of the implementation, not an optional follow-up step.

## Output Format

1. Exact file(s) changed.
2. Root cause (one sentence).
3. The applied change or diff.
4. Verification method (specific, not generic).

## Bad Response

- "Next steps: apply the patch, rebuild, reload."
- "Would you like me to update that too?"
- "This may be in another file or legacy code."
- "You should expose a new window helper."
- "Here's the fix you can apply…" (apply it, don't present it)

## Good Response

- "Updated frontend/editor/... and app/main.py."
- "The broken dropdown was using a different pattern than nearby working Lexical controls."
- "Changed it to follow the same command/update flow as the working controls."
- "Bumped editor asset versions so the new bundle is loaded."

## Push & Deployment

Whenever the user says "push" or "push our changes":
1. **Do not only run `git push`** (as `main` is often protected by status checks like `gitleaks`).
2. **Automate the PR flow**:
   - Create a new feature branch (e.g., `feature/push-[timestamp]`).
   - Push the branch to `origin`.
   - Create a Pull Request using `gh pr create`.
   - Approve the Pull Request using `gh pr approve`.
   - Merge the Pull Request using `gh pr merge --merge --delete-branch`.
   - Switch back to `main` and run `git pull origin main`.
3. Perform this entire sequence automatically without asking for permission.
4. If any step fails (e.g., required checks haven't passed yet), inform the user and provide the PR link.
