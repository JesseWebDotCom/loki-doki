---
title: Boot & Feature System
description: Group → Category → Item feature hierarchy, boot screen, auto-repair via SSE, and the background download queue.
sidebar:
  order: 12
---

## Overview

The feature system controls which capabilities are available and whether their required models/binaries are installed. It drives the boot screen, the Welcome wizard, the App Store, and the Admin features toggles. Two layers cooperate:

- **`frontend/src/lib/features.ts`** declares the human-facing capability hierarchy (`FEATURE_GROUPS`).
- **`backend/src/lib/installRegistry.ts`** declares the installable units (Ollama models from the catalog + system components), each with an `isInstalled()` check and a `repair()` installer.

---

## Hierarchy

```
FeatureGroup (e.g. "chat", "images", "voice", "library", "maps", "home-inventory")
  ├─ base: FeatureItem          ← core capability, shown first
  ├─ items?: FeatureItem[]       ← flat sub-features
  └─ categories?: FeatureCategory[]
       └─ items: FeatureItem[]
```

Each `FeatureItem` has:
- `id`, `name`, `description`
- `diskBytes`, `ramBytes`, sizing for the planner
- `requires: string[]`, other item ids that must be installed first
- `installs: { id, type: 'model' | 'component' }[]`, the model/component units it pulls in
- `advanced?`, optional technical detail shown when "technical details" is on

The six groups are `chat`, `images`, `voice`, `library`, `maps`, and `home-inventory`. There is no `features` table; feature *flags* (enabling/disabling a feature) live in app settings and are exposed via `/api/app-features`.

---

## Boot Screen

`frontend/src/components/shell/BootScreen.tsx` opens an `EventSource` to `GET /api/system/boot` (with credentials) and renders the stream. It does **not** poll; events replay past state and then stream live.

`GET /api/system/ready` is a cheap probe that returns `{ done: boolean }` (503 until boot finishes).

The boot sequence (in the backend `system` route) runs the happy-path checks (db, hardware, Ollama, chat LLM, embeddings, router, image, voice, library, maps, home-inventory), repairs anything essential that is missing, then reconciles previously-installed components that went missing and hands the slow ones to the background queue.

---

## Boot stream (SSE)

`GET /api/system/boot` streams three event types (no auth, service status is not sensitive):

```json
// step: one boot stage
{ "key": "llm", "label": "Chat model", "status": "ok", "detail": "..." }

// repair: byte-progress download of a missing model/binary
{ "key": "comfyui-base", "completed": 1234567, "total": 9000000, "speedBps": 250000, "etaSeconds": 30 }

// done: boot finished
{}
```

`status` is one of `running | ok | warn | error`. The screen maps step keys to friendly names, shows a progress bar for `repair` events, and fades out on `done`.

Auto-repair at boot is real: essential models (chat LLM, embeddings, router) block boot until repaired; ComfyUI Python venv is rebuilt if too old; partial image-model downloads resume in the background.

---

## Setup wizard

First-run install goes through `backend/src/routes/setup.ts` (`/api/setup`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/setup/status` | First-run / welcome state |
| `POST` | `/api/setup/admin` | Create the admin user |
| `GET` | `/api/setup/ollama-status` | Is Ollama installed/running (no auth) |
| `GET` | `/api/setup/catalog` | Hardware fit + model/disk plan |
| `POST` | `/api/setup/download` | Install essentials (**SSE**), hand off the rest to the queue |
| `POST` | `/api/setup/welcome-complete` | Mark the Welcome wizard seen |
| `PUT` | `/api/setup/state` | Persist wizard resume state |

---

## Background download queue (`download_jobs`)

Non-essentials finish after boot via a durable queue in `backend/src/lib/downloadJobs.ts`, backed by the `download_jobs` table. API in `backend/src/routes/jobs.ts` (`/api/jobs`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/jobs/status` | Aggregate counts + per-job progress |
| `POST` | `/api/jobs/enqueue` | Enqueue a non-essential set (admin) |
| `POST` | `/api/jobs/:id/retry` | Retry a failed job (admin) |
| `POST` | `/api/jobs/:id/cancel` | Cancel a running job (admin) |
| `POST` | `/api/jobs/retry-all-failed` | Retry all failed (admin) |

Queue behaviour:
- **Concurrency**: up to 4 jobs at once, at most 1 "large" (≥2 GB) job, and at most 1 per host/domain (ollama, huggingface, kiwix, maps, comfyui, github, local).
- **Lifecycle**: `pending → running → completed | failed | cancelled`, up to 6 attempts with exponential backoff; `.part` files allow resume rather than restart.
- **Priority**: archives > maps > models > components > Ollama models.
- **Prerequisites**: archives need `kiwix-tools`; maps need `maps-toolchain`; image models need `comfyui-base` + `comfyui-nodes`.
- Jobs are resumed on startup (`resumeDownloadJobs()`), so a crash mid-download recovers.

---

## Admin & App Store

- `GET /api/app-features` returns the feature-flag map; `PUT /api/app-features/:id` toggles a feature (admin).
- The App Store (`/api/app-store`) handles install/uninstall of apps and extensions, which install/remove the underlying registry components.
- Admin install/uninstall/queue tooling lives under `/api/admin/install`, `/api/admin/uninstall`, `/api/admin/queue`.

---

## Adding a New Feature

1. Add the `FeatureItem` (and any `installs` entries) to `FEATURE_GROUPS` in `frontend/src/lib/features.ts`.
2. If it needs a new installable unit, add a `model` to the catalog (`backend/src/lib/catalog.ts`) or a `component` to `backend/src/lib/installRegistry.ts` with `isInstalled()` and `repair()`.
3. The boot sequence, setup wizard, and queue pick it up via the registry; the boot screen and App Store render it automatically.
