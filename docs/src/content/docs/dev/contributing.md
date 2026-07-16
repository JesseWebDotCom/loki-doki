---
title: Contributing
description: Build commands, conventions, and the minimum testing bar.
sidebar:
  order: 13
---

## Prerequisites

- **Bun**, package manager and runtime (not npm/yarn). `run.sh` auto-installs it on first run if missing.
- **Ollama**, the app can install/manage it, but having it running locally helps.
- **ComfyUI** is installed by the app itself (it manages a Python runtime), no manual setup needed for image-gen work.

---

## Running

```bash
./run.sh            # macOS/Linux — production (build the UI, serve everything on :3000)
./run.sh --dev      # dev servers + HMR (Vite on :5173, hot-reloading backend on :3000)
```

On Windows use `.\run.ps1` / `.\run.ps1 -Dev` (siblings with the same behavior).
The launcher installs Bun if absent, stops any previous instance and its detached
sidecars, refreshes dependencies when the lockfile changed, opens the browser, and
then **supervises** the servers — a crashed backend/frontend is auto-restarted
(capped 5×/5 min). On exit it sweeps sidecars but leaves `ollama serve` running so
the next launch is instant. `--uninstall` / `-Uninstall` removes app data, models,
and ComfyUI/Ollama after a typed confirmation.

See [`/dev/launcher`](../launcher/) for the full launch sequence, flags, the
auto-restart loop, the Windows GPU brownout guard, and eGPU recovery.

The two dev servers can also be run by hand:

```bash
cd backend && bun run dev      # bun run --hot src/index.ts
cd frontend && bun run dev     # vite
```

There is no automated test suite. The bar for "done" is that both builds pass.

---

## Build Verification

After any **frontend** change:
```bash
cd frontend && bun run build   # tsc -b && vite build
```

After any **backend** change:
```bash
bun build --target=bun backend/src/index.ts
```

Both must exit 0 before a change is done. Never rely on `tsc --noEmit` alone, Vite's transform catches additional JSX/TSX errors that TypeScript misses.

---

## Code Conventions

### Frontend
- Use `cn()` from `@/lib/cn` for all className composition (clsx + tailwind-merge)
- Accent color: always `bg-brand`, `text-brand`, `border-brand`, `ring-brand`, never `violet-500` or the `primary` token
- Icons: `lucide-react` only, do not add other icon libraries
- Components in `shared/`: extend before duplicating; update `agents.md` catalog when adding

### Backend
- Use `bun:sqlite` (not better-sqlite3 or node:sqlite) via Drizzle (`backend/src/db/schema.ts`)
- Schema changes: edit `schema.ts` **and** mirror an idempotent statement in `runMigrations()` (`backend/src/db/index.ts`). Do not rely on `drizzle-kit generate`
- Proxy all AI calls, keys and Ollama URLs never reach the browser
- Add `think: false` to every Ollama request body
- Guard routes with `requireAuth` (or `requireAdmin`) from `backend/src/middleware/auth.ts`

### SSE Streaming
- Use Hono's `streamSSE` helper
- Chat token handler must replace the entire `messages` array, components in the message list must be wrapped in `React.memo`

---

## Architecture Decisions

See [`/dev/architecture`](../architecture/) for the full system overview.

When to use `/plan` before starting:
- Architecture changes
- Large refactors
- New subsystems
- Database schema changes
- API redesigns

Stay in execution mode for bug fixes, small features, and documentation.
