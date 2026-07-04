---
title: Coding
description: A real terminal wired to a persistent tmux session per user, wrapping a sandboxed Claude Code CLI process, with a headless chat-tool path.
sidebar:
  order: 28
---

## Overview

Coding (`/coding`) gives every user a real terminal (xterm.js), attached over WebSocket to their own **persistent tmux session** on the backend, which wraps a single **Claude Code CLI** (`claude`) process. Replaces an earlier OpenCode-based integration. The companion can also kick off a task here from chat via a separate **headless** path, see below.

Key files:

- `backend/src/lib/claudeCode.ts`: managed Claude Code CLI install
- `backend/src/lib/codingSandboxUser.ts`: OS-level sandbox user + passwordless-sudo launch script
- `backend/src/lib/codingServer.ts`: tmux session/pane lifecycle, model resolution, sandboxed command building
- `backend/src/lib/codingPtySidecar.ts` + `backend/scripts/coding-pty-sidecar.ts`: the Node PTY sidecar
- `backend/src/routes/coding.ts`: `/terminal` WS relay + `/pane/:action`
- `backend/src/tools/coding.ts`: the companion's headless `coding` chat tool
- `frontend/src/pages/coding/CodingPage.tsx`: the xterm.js terminal UI

---

## Managed install (`claudeCode.ts`)

`@anthropic-ai/claude-code` is installed as a pinned npm dependency (`CLAUDE_CODE_VERSION`, bumped deliberately, never on every install) into its own runtime dir, `data/coding/claude-runtime`, via `bun add` in that directory (so Bun resolves the correct platform binary itself, no OS/arch table to maintain). `CLAUDE_BIN` points at the installed binary; `isClaudeCodeInstalled()` gates the rest of the app on its presence (Admin → Features).

---

## The OS-level sandbox (`codingSandboxUser.ts`)

When supported (macOS/Linux; not Windows), install creates a dedicated, unprivileged OS user (`SANDBOX_USER = 'lokidoki-coding'`) with login shell `/usr/bin/false` (blocks interactive login) plus a **passwordless sudo rule scoped to one launch script**, not a blanket `NOPASSWD: ALL`:

```
$APP_USER ALL=($SANDBOX_USER) NOPASSWD: $LAUNCH_SCRIPT *
```

`LAUNCH_SCRIPT` (`coding-sidecar-launch.sh`) is a one-line `exec "$@"` owned by root and not writable by either the app user or the sandbox user, closing the gap a directly-`NOPASSWD`-sudoable arbitrary command would otherwise leave. `sandboxWrap()` in `codingServer.ts` is the single chokepoint that runs any coding-related command through `sudo -u lokidoki-coding "$LAUNCH_SCRIPT" ...` when the sandbox user is installed, real OS-level process/filesystem isolation, not just an app-level check.

**Fallback:** before the install step has run, or on Windows (unsupported), `workspaceDirFor()` falls back to `data/coding/users/<userId>`, a plain directory with **no OS isolation** — Claude Code's own interactive approval prompts are the only guard in that case.

`isSandboxUserInstalled()` self-tests with a real `sudo -n -u $SANDBOX_USER $LAUNCH_SCRIPT /usr/bin/true` rather than just checking the user exists, so a half-broken sudoers rule doesn't get treated as working.

---

## Session lifecycle (`codingServer.ts`)

One tmux session, always named `coding`, per user, wrapping a single `claude` process:

- **Workspace/HOME:** `workspaceDirFor(userId)` resolves the sandboxed or fallback path; Claude Code writes global config/skills to `$HOME` regardless of cwd, so each user gets a nested `.home` dir inside their own workspace (never shared, same reasoning as the old per-user `HOME` under OpenCode).
- **`resolveClaudeLaunch()`** builds the launch env for both the session's first pane and every later split: `HOME`, `SHELL=/bin/bash` (load-bearing — the sandbox user's real shell is `/usr/bin/false`, and tmux runs a pane's initial command through `$SHELL -c`, so without this override the pane launches via `/usr/bin/false` and dies instantly, taking a brand-new detached session's whole tmux server down with it), and `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN=ollama`/`ANTHROPIC_MODEL` pointed at Ollama's Anthropic-Messages-compatible endpoint, no proxy or translation shim needed to run the real Claude Code CLI against a local model.
- **Model:** the `coding` catalog role resolves an Ollama tag (falls back to `ornith:9b`), configurable via the `coding_model` app setting. Changing it requires `killTmuxSession()` since the env is baked in at session start, not re-readable mid-session.
- **`ensureTmuxSession()`** is idempotent and de-duped per user (an in-flight `Promise` map) so two browser tabs opening at once don't race to create the session twice. It also explicitly enables tmux mouse mode so drag-to-resize on a pane divider works (xterm.js forwards mouse events straight through; tmux's mouse mode consumes the drag).
- **`cwd` is load-bearing, not cosmetic:** the spawned process must get an explicit `cwd` inside the workspace dir; inheriting this backend's own cwd (unreachable to the sandboxed user) kills tmux's server before it can even process `-c <dir>`.
- **Panes (`paneControl`):** `split-h`/`split-v` map to tmux's `-h`/`-v` divider-orientation flags (side-by-side / stacked respectively, not "horizontal/vertical pane" in the arrangement sense), and always relaunch `claude` (with the same env) rather than tmux's default fallback shell, since a fresh pane in a coding-agent terminal should run the agent, not a bare shell. `close` just `kill-pane`s the session's active pane.
- **Runtime mirroring:** when sandboxed, Claude Code's binary is mirrored into `SANDBOX_RUNTIME_DIR` so the unprivileged sandbox user can execute it (`ensureSandboxRuntimeMirrored`). `ensureFreshSandboxRuntimeMirror()` wipes and re-mirrors if the expected binary is missing, guarding against a stale mirror left over from the old OpenCode-based version of this feature.

---

## Attach path (`/api/coding/terminal`, the PTY sidecar)

`buildAttachSpawnParams()` builds `sudo -u lokidoki-coding "$LAUNCH_SCRIPT" tmux -S <sock> attach-session -t coding`, deliberately passing a **minimal env** (not the full `process.env`, which carries this backend's own secrets) to the attach client.

tmux's own control commands (split/kill/has-session) run fine headless via `execFile`, but `attach-session` needs a **real PTY** (tmux checks `isatty()` on its controlling terminal). `node-pty`'s data-callback delivery is unreliable under Bun, so the actual PTY attach runs in a small **Node** sidecar process (`backend/scripts/coding-pty-sidecar.ts`, managed by `codingPtySidecar.ts`), not the main Bun server.

`GET /terminal` (`routes/coding.ts`) resolves the session cookie at WS-upgrade time (auth middleware doesn't run on upgraded sockets), then relays the browser's socket to the sidecar's socket **verbatim in both directions**. Messages arriving before the upstream sidecar socket is genuinely `OPEN` (the browser's initial terminal resize can easily beat that) are queued and flushed once it is, otherwise the very first resize is silently dropped and the PTY sticks at the sidecar's hardcoded 80x24 fallback forever. Closing the browser tab only kills this attach client; the tmux session (and `claude` inside it) keeps running server-side, that persistence across disconnect/reload is the entire point of the tmux-backed design.

---

## Headless path (companion `coding` tool, `tools/coding.ts`)

Lets chat kick off a task in the user's sandbox as a **separate, one-shot headless invocation** (`buildHeadlessClaudeCommand()` → `claude -p <task> --output-format json --permission-mode bypassPermissions`), independent of the user's own live interactive tmux session, so the two never fight over control of the same pane.

`--permission-mode bypassPermissions` auto-accepts edits/commands (a headless run can't prompt interactively), which is acceptable because the OS-user sandbox already contains the blast radius to that user's own workspace. The task runs with a 5-minute timeout; on completion (or timeout) it parses the CLI's JSON result and fires a `system` notification (`emitNotification`, `url: '/coding'`) with a short summary, this activity isn't visible in the terminal until it finishes, only the completion notification is.

---

## Regression notes

| Symptom | Likely cause |
|---|---|
| Session/pane dies immediately after `new-session -d` reports success | `SHELL` env not forwarded — tmux fell back to the sandbox user's `/usr/bin/false` login shell |
| `sudo`/tmux fails with a cwd/`getcwd()` permission error | Spawned without an explicit `cwd` inside the workspace dir; inherited the backend's own (inaccessible) cwd |
| Terminal stuck at 80x24 forever | The browser's initial resize message arrived before the upstream PTY sidecar socket was `OPEN` and wasn't queued/flushed |
| Split pane opens a plain shell instead of Claude Code | `split-window` called without re-specifying `claudeBin`/env as the trailing command |
| A stale OpenCode-only sandbox mirror never gets replaced | `SANDBOX_RUNTIME_DIR` existed but lacked the expected `claude` binary — `ensureFreshSandboxRuntimeMirror()` should have wiped and re-mirrored |
