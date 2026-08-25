---
title: Tech Stack
description: Full technology stack for MaiPai Home, runtime, UI, backend, and AI integrations.
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
- **TanStack Query (v5)**: data fetching, caching, background refetch
- **motion (v12)**: animation

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
- `dnd-kit`, drag-and-drop (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`)
- `sonner`, toasts
- `react-markdown` + `remark-gfm` / `remark-math` / `rehype-katex` + `katex`, message rendering
- `react-syntax-highlighter`, code blocks

### Maps, avatars & in-browser AI
- **maplibre-gl** + **pmtiles**, offline vector maps
- **@dicebear/core** + **@dicebear/collection**, companion avatars
- **onnxruntime-web**, in-browser OpenWakeWord (WASM); `scripts/copy-ort.mjs` copies the runtime assets on `predev` / `prebuild`
- **openmoji**, emoji assets (copied via `scripts/copy-openmoji.mjs`)

### Music engine (offline)
- **tonal**, **@tonejs/midi**, **spessasynth_core** / **spessasynth_lib**, client-rendered podcast stinger/intro music from a soundfont

---

## Backend

### HTTP / Framework
- **Hono**: lightweight, Bun-native HTTP framework
- **Server-Sent Events (SSE)**: LLM token streaming, image progress, boot repair

### Database
- **SQLite** via Bun's built-in `bun:sqlite` + **Drizzle ORM** (`drizzle-orm`, dialect `bun-sqlite`)
- PostgreSQL optional override via `DATABASE_URL` env var
- Schema in `backend/src/db/schema.ts`; inline `runMigrations()` is authoritative (do not rely on `drizzle-kit generate`)

### Auth & Security
- **Argon2id**: PIN hashing via `Bun.password.hash()` (no extra dep)
- **Pepper**: `PIN_PEPPER_SECRET` env var; falls back to a generated value in `app_settings`
- **HttpOnly cookie** named `session`: not JWT in localStorage (XSS-safe); only the token's SHA-256 hash is stored

### Backend libraries
- **hono**: HTTP framework
- **pino** / **pino-pretty**: logging
- **@huggingface/transformers** (3.8.x): Whisper STT inside the voice sidecar
- **kokoro-js**: Kokoro TTS in the voice sidecar
- **@openzim/libzim**: ZIM archive reads (alongside `kiwix-serve`)
- **osm-pbf-parser**, **geotiff**: maps build/geocoding helpers
- **chrono-node**: natural-language date parsing
- **obscenity**: content filtering

### AI Integration
- All AI calls proxied through backend, keys/URLs never reach the browser
- **Ollama**: chat, routing, embeddings, vision
- **ComfyUI** (Python, headless, default port 8188), image generation via workflow JSON
- **Voice sidecar** (Node worker spawned from `backend/scripts/voice-server.ts`), Kokoro TTS + Whisper STT in-process

---

## AI Stack

| Capability | Engine | Notes |
|---|---|---|
| Chat LLM | Ollama (admin-selectable) | Catalog offers `mannix/llama3.1-8b-abliterated` and `huihui_ai/gemma-4-abliterated` (12B, built-in vision); code default is `llama3.1:8b` |
| Routing (T1) | `all-minilm` (embed) | Cosine intent match, router index cached |
| Routing (T2) | `granite4.1:3b` | Kept warm; extracts tool args when T1 is uncertain |
| Embeddings (memory) | `nomic-embed-text` via Ollama | Memory/friendship semantic recall |
| Vision | Ollama VLM | Built-in if chat model is vision-capable, else `gemma3:4b` |
| TTS | Kokoro-82M (`kokoro-js`) | ONNX in the voice sidecar, sentence-chunked streaming |
| STT | Whisper (`whisper-tiny.en`) | In the voice sidecar via `@huggingface/transformers` (not browser WASM) |
| Wakeword | OpenWakeWord | `onnxruntime-web` WASM, in-browser |
| Image gen | ComfyUI + Juggernaut XL Ragnarok | SDXL checkpoint; LoRA, face-ID, video, bg-remove add-ons |

---

## Build Verification

After any frontend change:
```bash
cd frontend && bun run build   # tsc -b && vite build
```

After any backend change:
```bash
bun build --target=bun backend/src/index.ts
```

Both must exit 0 before a change is considered done. `tsc --noEmit` passes but Vite's transform catches additional JSX/TSX errors, never rely on `tsc` alone.
