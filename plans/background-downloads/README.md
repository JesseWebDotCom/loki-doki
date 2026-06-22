# Plan: Boot on essentials, download the rest in the background

## Goal
Stop making first-run users wait for ~100GB+ of optional content. Boot into a usable app
the moment the **essentials** are ready (Ollama + primary chat LLM), then download
everything else (other models, ZIMs, maps, components) in the **background** via a
persistent, server-driven job manager. Surface progress globally and per-app, with smart
concurrency and retries.

This extends the existing philosophy: the boot-repair system already auto-repairs missing
assets with inline progress (`system.ts` `reconcileInstalls` / `installed_components`
ledger). We generalize that into a durable job queue used at first-run too.

---

## Why the current design blocks this
- Downloads are **client-driven SSE**: `adminArchives`/`adminMaps`/`setup POST /download`
  stream progress to the browser, and we recently made them **abort on client disconnect**
  (`stream.onAbort`). Leaving `/setup` would kill background downloads. They must move to a
  server-owned job that runs regardless of the client.
- Models download **strictly one at a time** server-side (`setup.ts:235` loop). User wants
  smarter concurrency: **≤1 large at a time, ≤1 per domain**.
- There is **no persistent job/queue** for downloads (only `genQueue` for generation, and
  the boot `reconcileInstalls` ledger). We need one.

---

## Reused primitives (do NOT reinvent)
- `download.ts`: `pullOllama`, `downloadHfFile`, `downloadAndStartOllama`,
  `downloadComfyUIModel`, `downloadUrl` — all `(onProgress {completed,total,speedBps,
  etaSeconds,status?}, signal)`. `.part` + `Range` resume. `downloadLocks` per-dest.
- `installRegistry.ts`: `InstallComponent {id, group, label, isInstalled(), repair(onProgress,
  signal)}`; `installed_components` ledger; used by setup, boot-repair, admin.
- `adminArchives` ZIM download (stages, `zimArchives` table) and `adminMaps` build
  (`mapRegions` table, `installStatus`/`phase`).
- `settings.ts` `getAppSetting`/`setAppSetting` (`app_settings` k/v).
- Boot singleton pattern + SSE replay (`system.ts` `/api/system/boot`, `/api/system/ready`).
- Frontend: `ServerHealthContext` (poller + global banner) is the template for the new
  progress context/widget. `LeftSidebar` already supports nav `badge: 'busy'|'done'`.
  `appCategories.ts` apps carry an optional `feature`. `features.ts` items carry
  `installs: [{id, type:'model'|'component'}]` — the asset→feature mapping we need.

---

## Phase 1 — Backend download-job manager (the substance)

### 1a. Schema: `download_jobs` table (Drizzle + belt-and-suspenders in `db/index.ts`)
```
id          text pk
type        text   -- 'model' | 'archive' | 'map' | 'component'
ref_id      text   -- model id / zim sourceId+variant / region id / component id
domain      text   -- 'ollama' | 'huggingface' | 'kiwix' | 'maps' | 'comfyui' | 'github'
size_class  text   -- 'large' | 'small'
priority    int    -- lower runs first (essentials=0; rest by group)
status      text   -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
attempts    int    default 0
max_attempts int   default 4
last_error  text
progress    text   -- JSON {completed,total,speedBps,etaSeconds,note}
created_at / updated_at
```

### 1b. Scheduler (singleton worker loop, mirrors the boot singleton)
A tick function that starts eligible pending jobs. **Concurrency rules (per the user):**
- A job may start only if **all** hold:
  - `size_class==='small'` **OR** no other `large` job is currently running (≤1 large global).
  - no other running job shares its `domain` (≤1 per domain).
  - global running count < `MAX_CONCURRENT` (safety cap, e.g. 4).
- Effect: one big model can pull while several *small* items from *different* hosts also
  run — but never two large at once, never two hammering the same host. This replaces the
  current "models one at a time" loop and the ZIM worker-pool's host-blindness.
- Each running job gets an `AbortController`; progress callback throttled → `progress` JSON.
- On success → `completed`, add to `installed_components` ledger if applicable.

### 1c. Retries (confirmed required)
- On failure: `attempts++`; if `attempts < max_attempts` → back to `pending` with
  exponential backoff (next-eligible-at timestamp); else → `failed` (skipped, not retried).
- `.part` files mean retries resume, not restart.
- **Survives backend restart**: on boot, reset `running`→`pending` and resume the queue
  (extend `reconcileInstalls`). This is strictly better than today (client-driven dies on
  refresh).

### 1d. Endpoints
- `POST /api/setup/jobs/enqueue` — body: the non-essential selection (model ids, zim
  selections, map region, component ids). Creates `download_jobs` rows. Idempotent.
- `GET /api/jobs/status` — aggregate {total, completed, failed, running, pct} + per-job
  rows. (Polled by the widget; cheap.) Optional SSE `/api/jobs/stream` later.
- `POST /api/jobs/:id/retry`, `POST /api/jobs/:id/cancel` — for Admin.
- Respect `isDownloadBlocked()` (offline mode) — pause the scheduler when offline.

---

## Phase 2 — Setup wizard: gate boot on essentials only

- **Essentials set** = Ollama runtime + primary chat LLM (`model` role). (Open decision:
  also embeddings/router model? See below.)
- `DownloadStep` downloads ONLY essentials inline, keeping the current live UI + the
  per-item retry cap + the just-fixed single-pool concurrency.
- On essentials complete:
  1. `POST /api/setup/jobs/enqueue` with everything else (other models, ZIMs, maps, components).
  2. `setAppSetting('first_run_complete', true)`, clear `setup_state`.
  3. `onComplete()` → `refetch()` → navigate `/` (existing handoff at SetupWizard ~1833).
- The scheduler is now responsible for the rest; the browser is free to leave `/setup`.
- `AuthGuard`/`BootScreen` unchanged (boot already non-blocking re: optional assets).

---

## Phase 3 — Global background-progress widget

- New `SetupProgressContext` (template: `ServerHealthContext`): polls `/api/jobs/status`
  every ~3-5s while any job is pending/running; exposes `{aggregate, perJob, perFeature}`.
- `BackgroundSetupWidget` mounted beside `PrivacyOverlay`/`ServerHealthBanner` in `App.tsx`:
  collapsible corner card — "Setting up your apps… 45% — Vision, Maps, 12 archives left."
  Minimizable; auto-hides when all done; shows "N couldn't download — retry in Admin" if any
  `failed`.

---

## Phase 4 — Per-app readiness (graceful degradation)

- Compute feature readiness from `features.ts` `installs[]` vs job/ledger state (a
  `useFeatureReady(featureId)` hook off `SetupProgressContext`).
- **Nav badges**: `LeftSidebar` already supports `badge`; show `'busy'` pulse on apps whose
  assets are still downloading, clear when ready.
- **Per-page states** (extend existing empty-state patterns like `MapsPage` `NoRegionsNotice`):
  - Imaging/Video: page loads, Generate disabled → "Downloading image models… X%".
  - Maps: "Preparing your region… X%".
  - Library/Reader: archives appear as they finish (already data-driven).
  - Chat: image-attach / mic show "downloading vision/voice…" until ready; **text chat
    always works** (essentials guarantee it).

---

## Decisions (locked)
1. **Essentials** = Ollama + chat LLM + **embeddings + router** model. Good companion
   memory/routing from the first message. Everything else backgrounds.
2. **Concurrency**: ≤1 large + ≤1 per domain, `MAX_CONCURRENT = 4`, `max_attempts = 4`.
3. **Offline mode**: scheduler pauses when `isDownloadBlocked()`.
4. **Widget**: minimizable, not fully dismissable until done (so failures stay visible).
5. **Scope**: build all four phases in sequence.

---

## Suggested build order
1. Phase 1 (schema + scheduler + retries + endpoints + boot-resume) — the hard, valuable part.
2. Phase 2 (wizard essentials gating + handoff).
3. Phase 3 (widget + context).
4. Phase 4 (nav badges + per-app states).
Each phase is independently shippable and testable.
