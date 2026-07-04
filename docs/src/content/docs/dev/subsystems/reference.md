---
title: Reference (ZIM)
description: kiwix-serve integration, ZIM archive management, and the reader experience.
sidebar:
  order: 10
---

## Overview

Reference serves [ZIM](https://wiki.openzim.org/wiki/OpenZIM) archives (Wikipedia, Wiktionary, medical references, etc.) through a local kiwix subprocess that the backend proxies, surfaced at `/reference` (`ReferencePage.tsx`) and opened full-screen in `ReaderPage` at `/read/:sourceId`.

The same kiwix mechanism also backs book-shaped ZIM packs (Gutenberg, Wikibooks, textbooks, manuals…), those are presented in the [Books](../books/) app instead (`frontend/src/pages/books/ArchiveBrowsePage.tsx`, `BookCategoryPage.tsx`) and still open through the same `/read/:sourceId` reader. A `ZimSource.bookCategory?` field on the catalog entry (`zimCatalog.ts`) is the only thing that drives the split: set it and the source shelves in Books grouped by that category; leave it unset and it stays a plain Reference archive. `GET /api/archives/installed` exposes `bookCategory` so the frontend can partition without a second catalog. There is no separate "Offline Library" surface or archive-category tiles on Home/`/categories` anymore, this was consolidated away (see `AddOfflinePacksDialog.tsx`, shared by both apps' admin-add flow).

Relevant code:

- `backend/src/lib/kiwix.ts`: subprocess lifecycle + state machine
- `backend/src/lib/archives.ts`: download + verify/repair, `syncKiwixWithArchives()`
- `backend/src/lib/zimCatalog.ts`: `ZIM_CATALOG` (catalog of installable sources/variants), incl. `bookCategory?`
- `backend/src/lib/zimSearch.ts`: full-text search across installed archives (companion tools)
- `backend/src/routes/archives.ts`: status, installed list, favicon proxy, content proxy
- `backend/src/routes/adminArchives.ts`: catalog, SSE download, delete, verify (admin)
- `frontend/src/pages/reference/ReferencePage.tsx`: Reference app shell (archives + Dictionary/Medical entry points)
- `frontend/src/pages/ReaderPage.tsx`: full-screen reader, shared with Books
- `frontend/src/components/shared/AddOfflinePacksDialog.tsx`: admin-only pack picker, shared by Reference and Books
- `zim_archives` table in `backend/src/db/schema.ts`

---

## kiwix-serve subprocess lifecycle

The serving backend differs per OS (see `backend/src/lib/kiwix.ts`):

- **macOS / Linux** compile `@openzim/libzim` (via `npm install`, since `bun add` skips native lifecycle scripts) and run a custom `backend/zim-server.ts` under Bun. Articles are served at `http://127.0.0.1:8090/<bookName>/…`.
- **Windows** download the official static `kiwix-tools` bundle (`kiwix-serve.exe` + `kiwix-manage.exe`, pinned `3.7.0`). `kiwix-manage` builds a `library.xml`, then `kiwix-serve` serves articles at `http://127.0.0.1:8090/content/<bookName>/…`.

The port is fixed at `8090` (`KIWIX_PORT`), bound to `127.0.0.1` only. `kiwixContentBase()` / `kiwixContentRelPrefix()` abstract the per-OS URL scheme so the proxy never hardcodes either.

State machine: `idle | starting | ready | failed` (`getKiwixState()`). `spawnKiwix()` / `maybeSpawnKiwix()` launch the process and `startHealthPoll()` polls `/catalog/v2/entries` (up to 60s) until it answers, then marks `ready`. `stopKiwix()` SIGTERMs the child and, on Unix, kills only the LISTEN socket on `8090` (`lsof -ti tcp:8090 -sTCP:LISTEN`, never the backend's own PID).

Adding or removing an archive **requires a restart** of the subprocess so it picks up the new ZIM set, whether the archive is a Reference source or a Books pack. `restartKiwix(zimPaths)` serializes restarts through a promise chain (`restartChain`) so concurrent downloads don't stomp each other; the last call wins with the fullest archive list. (The reader shows an auto-refreshing "Setting up this archive…" placeholder while the restart settles.)

---

## Content proxy

`GET /api/archives/view/:sourceId/*` (`backend/src/routes/archives.ts`) is the proxy. It is intentionally **unauthenticated static content** (same posture as the maps tile route) so the iframe stays same-origin. For each request it:

1. Looks up the `zim_archives` row by `sourceId` to get `kiwixBookName`.
2. If the row is missing, or `kiwixBookName` is null, or kiwix isn't `ready`, returns a friendly `libraryStatusPage()` HTML (with a meta-refresh when a retry will help) instead of a raw error.
3. Fetches from kiwix-serve with `redirect: 'manual'` and follows the ZIM's internal redirect chain itself (up to 10 hops), tracking `effectivePath`, so the browser only ever sees one HTTP response (avoids Chrome's too-many-redirects limit on deep in-ZIM redirects like Wikipedia).
4. For HTML, rewrites absolute kiwix-serve paths (`href`/`src`/`action`/CSS `url()`) to the `/api/archives/view/:sourceId/` proxy base, injects a `<base>` tag (so `../` resolves to the ZIM root), hides the kiwix nav bar, and, when the `ld-theme` cookie is dark, injects a dark-mode CSS/JS payload (MediaWiki variable overrides, structural catch-alls, and a luminance-checked `invert()` fallback for arbitrary archives).
5. Non-HTML (CSS/JS/images/fonts) is streamed through with `content-type`/cache headers forwarded.

`GET /api/archives/favicon/:sourceId` discovers the favicon embedded in the ZIM (parsing the landing page's `<link rel=icon>`) and proxies it, cached in-memory per source.

> Note: `backend/src/routes/proxy.ts` is a **separate** reverse proxy for user bookmarks (`/api/proxy/:id`), not the kiwix proxy.

---

## How archives surface in the apps

`GET /api/archives/installed` returns each `zim_archives` row enriched from `ZIM_CATALOG` (`label`, `description`, `category`, `bookCategory`, `faviconUrl`, plus a `zimIconUrl` pointing at the favicon proxy). `ReferencePage` groups the entries with no `bookCategory` by `category` and renders each as a card linking to `/read/:sourceId`; entries with a `bookCategory` are picked up by the Books pages instead. `GET /api/archives/status` exposes `kiwixInstalled`, `kiwixState`, `kiwixError`, and the installed count for boot/health surfaces.

---

## ReaderPage (`/read/:sourceId`)

`frontend/src/pages/ReaderPage.tsx` resolves the archive from `/api/archives/installed`, then loads `/api/archives/view/:sourceId/` into a same-origin iframe (`sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"`). It provides browser-style chrome via `AppBreadcrumb`:

- Back / forward drive `iframe.contentWindow.history`.
- The search box opens `view/:sourceId/search?pattern=…` (kiwix's own full-text search).
- A shuffle button opens `view/:sourceId/random`.
- It reads `document.title` from the iframe on each load and publishes UI context (`usePublishUIContext`) so the companion knows which archive and article the user is reading.
- A CC-BY-SA credit line links to `/settings/about` (content licenses).

If the archive isn't installed it shows an empty state pointing at Admin → Features.

---

## Admin management (Admin → Features)

Archive install/uninstall lives in the Features manifest UI (`AdminFeaturesTab`), backed by `backend/src/routes/adminArchives.ts` (all routes `requireAdmin`):

- `GET /api/admin/archives/catalog`: `ZIM_CATALOG` annotated with install state.
- `GET /api/admin/archives/download/:sourceId?variantKey=`: SSE download stream (`status` / `progress` / `done` / `cancelled` / `error`); shares `downloadArchive()` with the background download-job manager. One active download per source (`activeDownloads` map); client disconnect aborts it.
- `POST /api/admin/archives/cancel/:sourceId`: abort an in-flight download.
- `DELETE /api/admin/archives/:sourceId`: delete the ZIM file + row, then `restartKiwix()` with the remaining set.
- `POST /api/admin/archives/install-kiwix`: SSE install of the kiwix runtime (compile `@openzim/libzim` on Unix, download `kiwix-tools` on Windows).
- `POST /api/admin/archives/verify`: scan installed archives, quarantine corrupt ones, and `syncKiwixWithArchives()` to re-serve the healthy set.

Downloads are blocked when the server is in offline mode (`isDownloadBlocked()` → `503`). `AddOfflinePacksDialog.tsx` is the shared admin-only dialog both Reference and Books use to browse the catalog and queue a download.

---

## `zim_archives` table

| Column | Notes |
|---|---|
| `id` | PK |
| `source_id` | unique; matches a `ZIM_CATALOG` entry |
| `variant_key` | which catalog variant (e.g. language / size) |
| `kiwix_book_name` | ZIM `Name` metadata → kiwix-serve URL path segment |
| `file_path` | on-disk `.zim` path under `data/zim/` |
| `file_size_bytes`, `zim_date` | size + ZIM build date (e.g. `2024-12`) |
| `downloaded_at`, `verified_at` | timestamps; `verified_at` = last passed corrupt-check |
| `created_at`, `updated_at` | timestamps |

ZIM files live under `data/zim/` (`kiwixZimDir`); each source gets its own subdirectory. `bookCategory` itself lives on the `ZIM_CATALOG` entry, not this table, it's presentation metadata, not install state.

---

## AI searchability

`backend/src/lib/zimSearch.ts` exposes `zimSearch(sourceIds, query, limit)` for companion tools (`backend/src/tools/search.ts`, `dictionary.ts`, `medical.ts`). It returns early unless kiwix is `ready`, then queries each requested book in priority order:

- **Unix:** `GET /<bookName>/search?pattern=…&format=json` (titles + snippets).
- **Windows:** `GET /suggest?content=<bookName>&term=…` (title-only; the static build has no JSON full-text endpoint).

`deriveZimAnswerPayload()` shapes results into a `gist` + `highlights` + `sources` payload, with each source linking back to `/api/archives/view/:sourceId/:path` so the companion can cite an article the user can open in the reader.
