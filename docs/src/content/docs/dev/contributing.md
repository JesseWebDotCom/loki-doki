---
title: Contributing
description: Build commands, conventions, and the minimum testing bar.
sidebar:
  order: 13
---

## Prerequisites

- **Bun** (package manager and runtime, not npm/yarn)
- **Ollama** running locally
- **ComfyUI** (for image generation work)

---

## Setup

```bash
# Install all dependencies
bun install

# Start the app (backend + frontend dev server)
./run.sh
```

---

## Build Verification

After any **frontend** change:
```bash
cd frontend && npx vite build
```

After any **backend** change:
```bash
bun build --target=bun backend/src/index.ts
```

Both must exit 0 before a change is done. Never rely on `tsc --noEmit` alone, Vite's Babel transform catches additional JSX/TSX errors that TypeScript misses.

---

## Code Conventions

### Frontend
- Use `cn()` from `@/lib/cn` for all className composition (clsx + tailwind-merge)
- Accent color: always `bg-brand`, `text-brand`, `border-brand`, `ring-brand`, never `violet-500` or the `primary` token
- Icons: `lucide-react` only, do not add other icon libraries
- Components in `shared/`: extend before duplicating; update `agents.md` catalog when adding

### Backend
- Use `bun:sqlite` (not better-sqlite3 or node:sqlite)
- All IDs via `ulid()`, not auto-increment
- Proxy all AI calls, keys and Ollama URLs never reach the browser
- Add `think: false` to every Ollama request body

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
