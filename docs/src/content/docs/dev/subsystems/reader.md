---
title: Reader
description: A personal reading library (live bookmarks + offline article archives, collections, tags, FTS, and a headless-Chromium capture engine).
sidebar:
  order: 14
---

## Overview

Reader is a per-user reading library. Each saved item (`reader_items`) is either a **live link** (a bookmark that opens the real site, in a new tab or an embedded/proxied iframe) or an **offline article** (a full server-side copy you can read with the network down). Items organize into **collections** and **tags**, are full-text searchable, and offline articles render in a cleaned **reader view** with a **Full page** snapshot toggle and an AI summarize/ask panel.

A small set of **global** items (`ownerId = null`) are admin-managed and shown to everyone; they're always live links. Reader also receives **promoted feed items** (saved RSS articles) and shares its data model with the legacy Links bookmarks feature it replaced.

---

## Data Model (`backend/src/db/schema.ts`)

### `reader_items`

```ts
reader_items
  id            text  primary key
  ownerId       text  → users.id (cascade); NULL = global/admin
  source        'bookmark' | 'article' | 'feed'
  sourceRef     text  nullable  // e.g. 'feed:<feedItemId>' for promoted feed items
  type          'live' | 'offline'
  url           text  not null
  title, byline, siteName, faviconUrl, excerpt   text
  contentHtml   text  // sanitized article body (offline)
  contentText   text  // plaintext, drives FTS / RAG / change-detection
  wordCount, readingMins   integer
  status        'unread' | 'reading' | 'archived'
  archiveState  'none' | 'pending' | 'fetching' | 'ready' | 'failed'
  archiveError  text
  readAt        timestamp
  useProxy, useEmbed   boolean
  category      text  default 'Other'
  collectionId  text  → reader_collections.id (set null)
  sortOrder     integer
  // change monitoring
  autoUpdate            boolean
  autoUpdateIntervalMins integer  nullable (null → daily)
  alertOnChange         boolean
  contentHash           text   // sha256 of normalized contentText (diff baseline)
  lastCheckedAt, contentChangedAt   timestamp
  // capture artifacts (under data/reader-archive/<id>/)
  screenshotPath, snapshotPath, ogImagePath   text
  isAdult       boolean
  createdAt, updatedAt   timestamp
```

### Supporting tables

- `reader_collections`: `id`, `ownerId`, `name`, `icon`, `color`, `sortOrder`. Per-user folders.
- `reader_tags`: `id`, `ownerId`, `name`. Per-user tag vocabulary.
- `reader_item_tags`: join table (`itemId`, `tagId`), composite PK.
- `reader_items_fts`: FTS5 external-content virtual table over `reader_items` (`title`, `excerpt`, `content_text`, **`url`**), kept in sync by `reader_items_ai/ad/au` triggers (defined inline in `backend/src/db/index.ts`). `url` is indexed so a domain query (e.g. `amazon`) matches a saved link by its address, not just its title. There's a guarded one-time rebuild that adds the `url` column to FTS tables created before it existed.

Per-user hiding of global items is **not** a column: it lives in `user_preferences` under the key `bookmarks.hidden` (a JSON array of item ids), reusing the legacy Links pref key.

---

## Backend Routes

### `/api/reader` (`backend/src/routes/reader.ts`, `requireAuth`)

- `GET /probe?url=...`: registered before `/:id`. `safeFetch` (SSRF-guarded) reports `{ reachable, framesBlocked, faviconUrl, title }`. `framesBlocked` derives from `X-Frame-Options` / CSP `frame-ancestors`; favicon + title parse from the HTML.
- `GET /`: list global + own items. Filters: `status`, `type`, `collectionId`, `tag`, `q` (FTS5, prefix-matches the last token). Heavy `contentHtml`/`contentText` omitted from the list; each row decorated with `tags`, `isGlobal`, `canEdit`, `isHidden`.
- `POST /`: create. `live` → immediate, enqueues a thumbnail job; `offline` → `archiveState='pending'`, enqueues the full archive job. Resolves `collectionName`/`tags`.
- `GET /:id`: one item with full content + tags.
- `PATCH /:id` / `DELETE /:id`: owner-scoped (404 otherwise). PATCH covers title/status/collection/tags/category/useProxy/useEmbed and the auto-update fields; flipping `autoUpdate` on for a never-captured item kicks a baseline archive.
- `POST /:id/rearchive`: re-run the archive job for an offline item.
- `POST /:id/snapshot`: accepts client-rendered DOM (JS executed in the user's proxied iframe, URLs de-proxied) and (re)enqueues the archive job to localize assets off it.
- `POST /:id/thumbnail`: accepts a client-rasterized PNG (`html-to-image`) → `og_image_path` = `thumb.png`.
- `GET /:id/archive/*`: serves the full-page offline snapshot (`index.html` + localized `assets/*`) and thumbnails from `data/reader-archive/<id>/`. Path-traversal guarded; content-type sniffed from magic bytes for extensionless assets.
- `GET /collections`, `POST /collections`, `PATCH/DELETE /collections/:id`: owner-scoped collections.
- `GET /tags`: owner tags (created implicitly when applied to items).
- `POST /import/html`, `GET /export/html`: Netscape `bookmarks.html` import/export (Shiori-style). Import flattens nested folders one level; the nearest `<H3>` folder becomes a collection. Export emits live links only.
- `POST /:id/summarize`, `POST /:id/ask`: AI TL;DR (+ auto-tags, persisted to the excerpt/tags for own items) and ask-the-article, via `lib/reader/ai.ts`.
- `PUT/DELETE /hide/:id`: add/remove a global item id from the user's `bookmarks.hidden` pref.

Two exported helpers, `promoteToReader` / `unpromoteFromReader`, are called by the Feeds save handler to mirror a saved RSS item into the library as a `source='feed'` offline item (idempotent per `ownerId`+`sourceRef`).

### `/api/admin/reader` (`backend/src/routes/adminReader.ts`, `requireAdmin`)

Manages global items (`ownerId IS NULL`, always `type='live'`). `GET /` lists, `POST /` creates (default category `Services`), `PATCH/DELETE /:id` edit/delete by id with no owner scoping.

### Mounting (`backend/src/index.ts`)

`/api/reader` and `/api/admin/reader` are mounted alongside the still-present legacy `/api/bookmarks` and `/api/admin/bookmarks`. Boot also calls `lib/reader/render.ensureChromium()` and `lib/reader/autoUpdate.startReaderAutoUpdatePoller()`.

---

## Capture / Archive Engine (`backend/src/lib/reader/`)

The default capture path is **server headless Chromium** (`render.ts`, Playwright): the page renders in a real browser (JS executes), yielding fully-rendered HTML + a screenshot. It runs inside the `archive-article` download-queue job (`archive.ts`), so every save path (UI, bookmarklet, companion tool, scheduled refresh) works without the user's browser open. `ensureChromium()` prefers an installed Playwright Chromium, then a system Chrome/Edge channel, then self-installs Playwright's Chromium under `data/bin/playwright`.

`archive.ts` produces **both** a full-page snapshot (every asset downloaded under `data/reader-archive/<id>/` via `snapshot.capturePage`) and a cleaned reader view (`contentHtml`/`contentText`, images repointed at local copies), so the UI toggles Reader ⇄ Full page entirely offline. Fallbacks (client-rendered snapshot via `POST /:id/snapshot`, then static fetch) are handled upstream. `thumbnail.ts` generates card thumbnails. SSRF is enforced on the top URL and every subresource since URLs are user-controlled and the server sits next to Ollama/ComfyUI/the router.

**Change monitoring** (`autoUpdate.ts`): a poller (default cadence: items with no explicit interval refresh daily) re-archives `autoUpdate` items when due. It hashes the normalized `contentText` (`contentHash`) so cosmetic reflow doesn't read as a change; when the reader-text actually changes and `alertOnChange` is set, the owner gets a notification.

---

## Frontend

### Routes (`frontend/src/App.tsx`)

`/reader` mounts `ReaderLayout` (`components/reader/ReaderLayout.tsx`), which renders the rail + an `<Outlet>`:

- index → `ReaderLibraryPage` (`pages/reader/ReaderLibraryPage.tsx`)
- `collection/:id` → `ReaderLibraryPage` (collection-filtered)
- `read/:id` → `ReaderReadPage` (`pages/reader/ReaderReadPage.tsx`)
- `settings` → `ReaderSettingsPage` (`pages/reader/ReaderSettingsPage.tsx`)

All `/api/reader/*` calls go through the typed wrappers in `frontend/src/lib/reader/api.ts`.

> Not part of Reader: `/read/:sourceId` → `ReaderPage` is the **ZIM/Reference** reader (see the [Reference](/dev/subsystems/reference/) subsystem), unrelated to this feature despite the similar name.

### Rail (`components/reader/ReaderRail.tsx`)

The left sidebar: a **Save** button; filters **All / Unread / Archived**; a **Type** section (**Live links / Offline articles**); the user's **Collections** (with inline create + a `CollectionEditor` for icon/color/delete); a **Tags** cloud; and a footer with **Settings**, **Import bookmarks** (uploads a `bookmarks.html` → `POST /import/html`), and **Export bookmarks** (links straight to `GET /export/html`). Filters live in the query string, so the rail computes its own active state.

### Library page

`ReaderLibraryPage` renders a card grid (thumbnail, favicon, title, excerpt, an archive/reading-time badge, collection chip, tags). Cards poll while any item is mid-archive so badges flip to ready. Live un-embedded links open in a new tab; everything else opens `read/:id`. Per-card actions (own items): move-to-collection, edit, open original, archive/unarchive, delete. Search comes from the shared breadcrumb search box.

### Read page

`ReaderReadPage`: live links embed the site (`/api/proxy/:id` when `useProxy`); offline articles render `ArticleReader` (cleaned, locally-imaged) with a **Reader ⇄ Full page** toggle (the full snapshot loads `/:id/archive/index.html` in a sandboxed iframe), a re-archive button, the `ReaderAutoUpdateMenu`, an archive toggle, and the `ReaderAIPanel` (summarize / ask). Opening an unread offline article flips it to `reading`.

### Settings + admin surface

`ReaderSettingsPage` shows `SettingsSaveToLokiTab` (the **Save to Loki** bookmarklet + mobile share-sheet hint) to everyone, plus an admin-only **Global links** section that renders `AdminLinksTab` (manages the global, admin-shared live links via `/api/admin/reader`). There is no separate admin-panel nav entry for Reader; global-link management lives here in the app's own Settings.

---

## Legacy Links surface (retired, still in the tree)

Reader replaced the old **Links** feature. The legacy `LinksPage` (`/links`), `LinkViewPage` (`/links/:id`), the `/api/bookmarks` + `/api/admin/bookmarks` + `/api/proxy` routes, and the standalone `AdminLinksTab` admin tab still exist in the codebase but are **out of the navigation / retired and slated for removal**. (`AdminLinksTab` itself is reused, embedded inside Reader's Settings, for managing global shared links.) This is a docs-level note; no code change is implied.
