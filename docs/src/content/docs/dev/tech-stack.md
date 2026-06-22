---
title: Tech Stack
description: Full technology stack for loki-doki-v3, runtime, UI, backend, and AI integrations.
sidebar:
  order: 2
---

## Runtime & Tooling

| Tool | Version | Role |
|---|---|---|
| Bun | latest | Package manager, runtime, test runner |
| Vite | 6 | Frontend build + dev server |
| TypeScript | ~5.8 | Full-stack type safety |

Use `bun` everywhere, not `npm` or `yarn`.

---

## Frontend

### Core
- **React 18**: UI library
- **react-router-dom v6**: client-side routing
- **TanStack Query**: data fetching, caching, background refetch

### Styling
- **Tailwind CSS v4**: CSS-first config via `src/index.css` (no `tailwind.config.js`)
- **shadcn/ui**: component library (style: `new-york`, base: `neutral`, CSS vars enabled)
- **Radix UI**: primitives backing shadcn components (via `radix-ui` package)

### Design Tokens

The accent token is `--brand` / `--brand-foreground`. Use only:

```css
bg-brand   text-brand   border-brand   ring-brand
```

Never hardcode `violet-500` or the `primary` token for accent UI.

| Mode | Value |
|---|---|
| Dark | `oklch(0.72 0.22 290)` |
| Light | `oklch(0.44 0.22 290)` |

### Utilities
- `clsx` + `tailwind-merge`, compose via `cn()` from `@/lib/cn`
- `class-variance-authority`, variant-based component APIs
- `lucide-react`, icon library (do not add others)
- `dnd-kit`, drag-and-drop (`@dnd-kit/core`, `sortable`, `modifiers`, `utilities`)

---

## Backend

### HTTP / Framework
- **Hono**: lightweight, Bun-native HTTP framework
- **Server-Sent Events (SSE)**: LLM token streaming, image progress, boot repair

### Database
- **SQLite** via Bun's built-in `bun:sqlite` + **Drizzle ORM**
- PostgreSQL optional override via `DATABASE_URL` env var

### Auth & Security
- **Argon2id**: PIN hashing via `Bun.password.hash()` (no extra dep)
- **Pepper**: `PIN_PEPPER_SECRET` env var (256-bit hex, never in DB)
- **HttpOnly session cookies**: not JWT in localStorage (XSS-safe)

### AI Integration
- All AI calls proxied through backend, keys/URLs never reach the browser
- **Ollama**: chat, routing, embeddings, vision
- **ComfyUI** (headless, port 8188), image generation via workflow JSON
- **Voice sidecar** (`backend/scripts/voice-server.ts`), Kokoro TTS + Whisper STT

---

## AI Stack

| Capability | Engine | Notes |
|---|---|---|
| Chat LLM | Ollama (any model) | Default: huihui_ai/gemma-4-abliterated:latest 12B |
| Routing | all-minilm (embed) + granite4.1:3b (T2) | See [Chat & Routing](../subsystems/chat/) |
| Embeddings (router) | all-minilm via Ollama | Tool intent matching, router index |
| Embeddings (memory) | nomic-embed-text via Ollama | Memory/friendship semantic recall |
| Vision | Ollama VLM | Structured JSON output |
| TTS | Kokoro-82M | ONNX, sentence-chunked streaming, no Python |
| STT | Whisper | Via transformers.js / onnxruntime-wasm |
| Wakeword | OpenWakeWord | WASM in-browser |
| Image gen | ComfyUI + Juggernaut XL | SDXL 1.0, LoRA support |

---

## Build Verification

After any frontend change:
```bash
cd frontend && npx vite build
```

After any backend change:
```bash
bun build --target=bun backend/src/index.ts
```

Both must exit 0 before a change is considered done. `tsc --noEmit` passes but Vite's Babel transform catches additional JSX/TSX errors, never rely on `tsc` alone.
