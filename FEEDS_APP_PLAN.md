# Feeds App — Implementation Plan

**Status:** Approved direction, not yet implemented. Hand-off doc for an implementing session.
**Goal:** Build a real RSS reader ("Feeds") that **absorbs** the existing curated News app. Curated sources become non-removable *system feeds* (`userId = null`); users subscribe to arbitrary RSS/Atom feeds on top. One engine, two front-ends:

- **News app** = zero-config curated view over *system feeds only* (looks identical to today).
- **Feeds app** = full RSS reader — user subscriptions, folders, read/saved state, LLM classifier.

One parser, one item store, one read-state table, one classifier — two surfaces. News does not die; it becomes the curated preset of the feed engine.

> Inspired by NewsBlur. We borrow the *ideas* (user-subscribable feeds, intelligence trainer, full-text extraction, OPML, saved-searches-as-feeds), **not** its stack (Django/Postgres/Mongo/Redis/ES/Celery/Backbone — irrelevant to our Bun/SQLite/React world). Explicitly skipped: blurblog/social sharing, Track Changes, email-newsletter ingestion.

---

## Codebase conventions that MUST be respected

- **DB migrations:** edit `backend/src/db/schema.ts` (Drizzle defs) **AND** add an inline idempotent migration in the existing `runMigrations()` in `backend/src/db/index.ts` (belt-and-suspenders). **Do NOT run `db:generate`.** The journal stops at 0016; `runMigrations()`'s inline `CREATE TABLE IF NOT EXISTS` + `addColumn()` block is the **authoritative** schema source. Use raw SQL `sqlite.exec()` blocks (not Drizzle) inside `runMigrations()`, mirroring the existing pattern. `PRAGMA foreign_keys = ON` is set, so create tables in FK-dependency order.
- **`addColumn(table, col, ddl)`** exists (index.ts:20) and swallows "duplicate column name" — use it for later column additions; for brand-new tables use `CREATE TABLE IF NOT EXISTS`.
- **UI reuse:** centralize in `frontend/src/components/shared/`; extend before duplicating. Reuse `NewsCard.tsx` (`NewsFeature`, `NewsRow`).
- **App registration is lightweight** (see "Reality checks" below) — an `AppItem` in `appCategories.ts` + a route in `App.tsx`, optionally a feature flag. There is **no** per-app install/uninstall lifecycle.

---

## Reality checks (assumptions corrected after reading the code)

1. **No "App Store install/uninstall" mechanism** in the sense of a lifecycle. Three distinct systems exist:
   - `backend/src/lib/catalog.ts` = **model** catalog (Ollama/ComfyUI weights). Not relevant.
   - `backend/src/lib/installRegistry.ts` = **component/binary** installer. Feeds needs no binary → **no entry**.
   - `backend/src/routes/appStore.ts` = only files an `install_request` admin notification. Not an install mechanism.
   - **Real "register an app"** = add an `AppItem` to `frontend/src/lib/appCategories.ts` (`APP_GROUPS`) + a route in `frontend/src/App.tsx`. Optional admin on/off via `feature` (`backend/src/routes/appFeatures.ts`, hardcoded `APP_FEATURE_IDS` array — add `'feeds'`). Global `uninstall.ts` wipes the whole `data/` dir; new tables need no special handling there.
2. **`db:generate` confirmed off-limits** (index.ts:35-41). Inline `runMigrations()` SQL is authoritative.
3. **`enrichOgImages` mutates items in place** and is generic over `{url, imageUrl}` — extending `ogImage.ts` for Readability is sound (63 lines; fetch+cache+bounded-concurrency scaffold to copy).
4. **Per-user-state pattern confirmed** via `ytWatchState`/`ytCollections`/`podcastWatchState`: all use `unique().on(userId, ...)` + `text('id').primaryKey()` UUIDs. `feedItemState` follows this with `unique(userId, itemId)`.
5. **Auto-podcast wiring confirmed** (`backend/src/lib/youtube/automation.ts:270`): looks up `podcastShows` where `autoGenerate=true AND sourceRef = '${kind}:${externalId}'`. Our `feed:<id>` sourceRef fits. **`podcastEpisodeSources.sourceType` is an enum currently `['youtube']`** — must add `'feed'` to the Drizzle enum (SQLite doesn't enforce, Drizzle does).
6. **The poller has NO conditional-GET today.** `youtube/feed.ts` refetches full XML every 15 min. Conditional GET (etag/Last-Modified) + per-host throttle is **net-new** work. Reuse only: the regex parser, batched concurrency, `_polling` overlap guard, and the stale-filter loop.
7. **News has NO DB backing today** — `routes/news.ts` is a pure in-memory SWR `Map` cache over `worldHeadlines()`/`patchLocal()`. Absorbing News is a real migration and the **highest-regression-risk** item (sequenced carefully, last, with a live fallback).
8. **`feedItems` is never per-user.** System feeds (`userId=null`) store items **once, shared** (like `ytVideos` — global, with per-user `ytWatchState`). User feeds also store once per feed. Only `feedItemState` is per-user. Dedup key is **`(feedId, guid)`**, NOT global guid (same article legitimately appears in two feeds).
9. **ZIM `ReaderPage.tsx` is an iframe wrapper around kiwix-serve** — not a generic article renderer; its chrome is ZIM-specific. Reuse the *shell layout* (AppBreadcrumb header + full-height scroll container) but render **sanitized `contentHtml` directly** (use the existing markdown/sanitizer path, e.g. `MarkdownRenderer.tsx` / DOMPurify if present — verify), NOT an iframe. New page at `/feeds/read/:itemId`; do **not** overload `/read/:sourceId` (ZIM archives).

---

## Schema (final)

Add to `backend/src/db/schema.ts` (Drizzle defs) **and** mirror as raw SQL in `runMigrations()`. Place after the podcast tables. **FK-dependency order in the inline SQL:** create `feed_folders` and `feeds` before `feed_items`/`feed_item_state`.

```
feeds
  id            text pk
  userId        text NULL refs users(id) onDelete cascade   -- NULL = system/curated
  kind          text enum('rss','atom','search','youtube') default 'rss'
  url           text                 -- feed URL (null for kind='search')
  query         text                 -- for kind='search' (googleNewsSearch wrapper)
  title         text default ''
  faviconUrl    text
  siteUrl       text                 -- homepage (from autodiscovery; favicon + display)
  folderId      text refs feed_folders(id) onDelete set null
  isSystem      integer bool default 0    -- explicit & indexable (NULL userId is awkward to query)
  sortOrder     integer default 0         -- system-feed ordering on News page
  notify        integer bool default 0    -- Phase 4 new-item notifications (off by default)
  etag          text
  lastModified  text
  lastFetchedAt integer ts
  lastError     text
  pollIntervalSec integer            -- per-feed override (system less often)
  addedAt       integer ts notNull
  unique(userId, url)                 -- see NULL gotcha below
  index(userId), index(isSystem)

feed_folders
  id text pk, userId text notNull refs users, name text, sortOrder integer default 0, createdAt ts

feed_items
  id          text pk
  feedId      text notNull refs feeds(id) onDelete cascade
  guid        text notNull           -- dedup key (entry guid/id, fallback url, fallback hash)
  title       text
  url         text
  author      text
  summary     text
  contentHtml text                    -- Phase 2 full-text; offline store
  imageUrl    text
  publishedAt integer                 -- Unix ms (nullable)
  fetchedAt   integer ts notNull
  unique(feedId, guid)                -- DEDUP: per-feed, not global
  index(feedId, publishedAt desc)     -- hot query: feed view newest-first
  index(publishedAt)                  -- "All" cross-feed view

feed_item_state
  id text pk
  userId  text notNull refs users onDelete cascade
  itemId  text notNull refs feed_items(id) onDelete cascade
  read    integer bool default 0
  saved   integer bool default 0
  readAt  integer ts
  unique(userId, itemId)
  index(userId, saved), index(userId, read)

-- Phase 3 --
feed_interests
  userId       text pk               -- one row per user (singleton)
  interestsText text
  likesJson    text default '[]'
  hidesJson    text default '[]'
  updatedAt    ts

feed_item_scores                      -- separate so re-scoring/pruning is cheap; per-user, recomputable
  id text pk, userId text notNull, itemId text notNull, score real, reason text, scoredAt ts
  unique(userId, itemId)
```

**NULL-unique gotcha:** SQLite treats `NULL` as distinct in unique indexes, so two system feeds with the same `url` can both insert under `unique(userId, url)`. **Guard the seed** with an explicit `SELECT ... WHERE url=? AND userId IS NULL` (or key on `isSystem`+url) before insert. Do not rely on the unique constraint for system feeds.

---

## Phase 1 — Core feed engine + News absorption

### 1a. Shared parser — `backend/src/lib/feeds/parse.ts` (new)
Factor the regex logic out of `briefing/sources/rss.ts` and `youtube/feed.ts` into one parser handling RSS `<item>` and Atom `<entry>`.

```ts
export interface ParsedEntry {
  guid: string          // <guid>/<id>, fallback to link
  title: string
  url: string
  author: string | null
  summary: string | null      // stripHtml(description/summary), capped
  contentHtml: string | null  // raw <content:encoded>/<content> if present
  imageUrl: string | null     // media:*/enclosure
  publishedAt: number | null  // Unix ms
}
export function parseFeedXml(xml: string):
  { title: string | null; siteUrl: string | null; entries: ParsedEntry[] }
export { stripHtml }
```
Reuse verbatim from `rss.ts`: `extractXml`/`extractTag`, `stripHtml`, `extractFeedImage`, `upscaleImage`. Have `briefing/sources/rss.ts` and `youtube/feed.ts` keep thin wrappers but import the shared helpers (don't move youtube's `yt:videoId` logic — only the generic primitives).

### 1b. Autodiscovery — `backend/src/lib/feeds/discover.ts` (new)
```ts
export async function discoverFeeds(siteOrFeedUrl: string, timeoutMs = 5000):
  Promise<{ url: string; title: string | null; kind: 'rss'|'atom' }[]>
```
Fetch URL; if XML root `<rss>`/`<feed>` → return it; else regex-scan HTML for `<link rel="alternate" type="application/rss+xml|atom+xml" href=...>`. **Use `backend/src/lib/ssrfGuard.ts`** (verify export name) before fetching arbitrary user-pasted URLs.

### 1c. Poller — `backend/src/lib/feeds/poller.ts` (new)
Model on `youtube/feed.ts` (copy `_polling` overlap guard, `FEED_CONCURRENCY` batching, stale-filter loop). **Add:**
- **Conditional GET:** send `If-None-Match: etag` / `If-Modified-Since: lastModified`; on `304` skip; on `200` store new `etag`/`last-modified` headers.
- **Per-host throttle:** `Map<host, lastFetchMs>`; ensure ≥ N seconds between same-host requests (user feeds cluster on substack.com etc.).
- **Per-feed interval:** respect `feeds.pollIntervalSec` (system ~15min; user 15–30min).
- **Prune** (see gotchas): keep newest N per feed / items < 30 days, **never delete items with `feed_item_state.saved=1`**.

```ts
export async function fetchAndUpsertFeed(feed: Feed): Promise<number>   // # new items
export async function refreshUserFeeds(userId: string): Promise<void>
export async function refreshSystemFeeds(): Promise<void>
export async function refreshFeed(feedId: string): Promise<number>
export function startFeedPoller(): void   // setInterval, overlap-guarded
```
Upsert = mirror `upsertSubscriptionVideos`: one `inArray` query on `(feedId, guid)` to find known, insert fresh with `onConflictDoNothing()`. Update `lastFetchedAt`/`etag`/`lastModified`/`lastError`. **Wire** `startFeedPoller()` into `backend/src/index.ts` next to `startYoutubeFeedPoller()` (~line 136).

### 1d. Seed system feeds — `backend/src/lib/feeds/seed.ts` (new)
```ts
export async function seedSystemFeeds(): Promise<void>   // idempotent
```
Upsert one `feeds` row (`userId=null, isSystem=1`) per entry in the existing `WORLD_FEEDS` const — **export `WORLD_FEEDS` from `briefing/sources/rss.ts`** (single source of truth; don't duplicate URLs). Guard with the NULL-unique check above. Call from `index.ts` after `runMigrations()` (~line 93), before `startFeedPoller()`, then kick a background `refreshSystemFeeds()`.

### 1e. Routes — `backend/src/routes/feeds.ts` (new)
Mirror `youtube.ts` structure; `feedsRoute.use('*', requireAuth)`. Register `app.route('/api/feeds', feeds)` in `index.ts` near the news route (~line 250).

```
GET    /api/feeds                  -> user + system feeds merged, with folder + unread counts
POST   /api/feeds                  -> {url|siteUrl}: discover+create user feed, bg refresh
POST   /api/feeds/discover         -> {url} -> candidate feeds (1b)
DELETE /api/feeds/:id              -> only if userId===user.id (system feeds NON-removable: 403)
PATCH  /api/feeds/:id              -> rename / move folder (user feeds only)
POST   /api/feeds/:id/refresh      -> refreshFeed
GET    /api/feeds/items            -> q: feedId?|folderId?|saved?|unread?, cursor, limit
                                       LEFT JOIN feed_item_state ON (itemId AND userId=?); newest-first
PATCH  /api/feeds/items/:id        -> {read?, saved?} upsert feed_item_state (unique userId,itemId)
POST   /api/feeds/items/read-all   -> mark feed/folder read
GET/POST/PATCH/DELETE /api/feeds/folders
POST   /api/feeds/opml/import      -> parse OPML, bulk-create feeds
GET    /api/feeds/opml/export      -> emit OPML (Content-Type text/x-opml)
```
Items hot path: `feed_items LEFT JOIN feed_item_state ON (itemId AND userId=?)`, filter, `ORDER BY publishedAt DESC LIMIT`. System-feed items visible to all; user-feed items filtered to feeds the user owns.

### 1f. News absorption (lowest-risk path — do LAST in Phase 1)
- **Do NOT rip out `routes/news.ts`.** Keep `/api/news` working as-is first (zero regression).
- Add system feeds + seeding so the unified store exists in parallel.
- Then switch `routes/news.ts`'s `fetchItems('world')` to **read from the feed store** (system-feed items, newest-first, deduped by title) instead of calling `worldHeadlines()` live. **Keep the same `NewsItem[]` response shape** so `frontend/src/lib/news/useNews.ts`, `NewsPage.tsx`, `HomePage.tsx` are **untouched**. `worldHeadlines()` becomes the poller's fetch mechanism, not the request path.
- **`local` news stays on `patchLocal()`** (scraper, not RSS) — leave that branch alone. Only `world` migrates. Document the asymmetry.
- **Regression guards:** News must show items before the first poll completes → on seed, do an immediate `refreshSystemFeeds()` and have `fetchItems('world')` **fall back to live `worldHeadlines()` if the store is empty**. Move `enrichOgImages` to run **at poll-time** on system-feed items (persist into `feedItems.imageUrl`) instead of per-request scraping.

### 1g. Frontend
- **`frontend/src/pages/FeedsPage.tsx`** (new) — two-pane: left rail (All / folders / Saved / per-feed with unread badges), right list. **Reuse `NewsFeature`/`NewsRow`** from `components/shared/NewsCard.tsx` (map `feedItem → NewsItem`: title/url/source/summary/imageUrl/publishedAt). Add read/unread treatment (dim read) + a save toggle overlay. Prefer a thin `FeedRow` wrapper in `shared/` over forking `NewsRow`.
- **`frontend/src/lib/feeds/api.ts` + `useFeeds.ts`** (new) — mirror `lib/news/useNews.ts` + `lib/youtube/api.ts` (react-query options).
- **Route** in `App.tsx` — `<Route path="/feeds">` with index + `:feedId` + `saved` children (mirror youtube/podcast nested-route blocks ~lines 241-251).
- **Register app** — add a `feeds` `AppItem` to the `today` group in `frontend/src/lib/appCategories.ts` (`to: '/feeds'`, icon `Rss`). Keep News as a separate AppItem (News = curated, Feeds = full reader).

### Phase 1 risks / gotchas
- **Dedup:** `(feedId, guid)`; guid fallback chain `guid → id → url → hash(title+pubDate)`. Cross-feed title dedup only in the *News view* (system feeds overlap), not at storage.
- **Retention/pruning:** unbounded `feedItems` grows forever. Prune in poller: keep newest N (~200) per feed OR items < 30 days, **never delete saved items** (mirror the "manual saves never expire" rule from `ytDownloads`). Bounded per run.
- **Thundering herd:** copy `FEED_CONCURRENCY` batching + per-host gap. On boot, system + all users' feeds may be stale at once — stagger.
- **OPML import** can create hundreds of feeds → bulk insert, then **one** background refresh pass (not N immediate `void refresh` calls like the youtube import does for its handful).

---

## Phase 2 — Readability full-text + offline + reader view

### 2a. Extractor — `backend/src/lib/feeds/readability.ts` (new)
Reuse `ogImage.ts`'s UA/cache/bounded-worker pattern (new file keeps `ogImage.ts` focused). **Bun has no DOM** → use a heuristic extractor (largest `<article>`/`<p>` density) matching the codebase's zero-dep style (rss.ts/ogImage.ts), OR add a dependency only after confirming none is installed. Reuse `ogImage.ts` og:image extraction for the lead image.
```ts
export async function extractArticle(url: string, timeoutMs = 8000):
  Promise<{ contentHtml: string | null; imageUrl: string | null; title: string | null }>
```
Persist into `feedItems.contentHtml`. Run **lazily** (first reader open) or as a bounded background pass after poll — NOT inline in the list request. SSRF-guard the fetch.

### 2b. Reader route + view
- `GET /api/feeds/items/:id/content` — return stored `contentHtml`; if null, `extractArticle`, store, return.
- **`frontend/src/pages/FeedReaderPage.tsx`** (new) at `/feeds/read/:itemId` — reuse the ZIM reader's **shell layout** (AppBreadcrumb + full-height scroll), render **sanitized** `contentHtml` directly (existing markdown/sanitizer path; verify DOMPurify presence). Not an iframe; not `/read/:sourceId`.

### Phase 2 gotchas
- **Sanitize untrusted article HTML** (find existing sanitizer — chat markdown renderer).
- Offline = `contentHtml` in DB (free once extracted), but images remote → optionally proxy/cache via existing `/api/proxy` for true offline.

---

## Phase 3 — LLM classifier / trainer

- **Tables:** `feed_interests`, `feed_item_scores` (above).
- **`backend/src/lib/feeds/classifier.ts`** (new):
```ts
export async function scoreItems(userId: string, items: FeedItem[]): Promise<Map<string, number>>
```
Use existing `ollamaChat` from `@/llm/ollama` + `getFastModel()` from `@/lib/models` (both already used in `youtube.ts`). **Batch** (one prompt scoring 10–20 titles+summaries → JSON array) and **cache** in `feed_item_scores` `(userId, itemId)`. Build prompt from `feedInterests.interestsText` + `likesJson`/`hidesJson`.
- **Routes:** `GET/PUT /api/feeds/interests`; `POST /api/feeds/items/:id/feedback {up|down}` (append to likes/hides, invalidate that item's score).
- **UI:** thumbs up/down on cards (reuse save-button overlay slot); fold/dim low-score items with "show hidden" expander; highlight high-score. "Trainer" settings panel for `interestsText`.

### Phase 3 gotchas
- Scoring is best-effort/async — **never block the list**. Score only unscored items in the current page window (bounded, like og enrichment's `max`). Do it in background after first paint, then refetch scores.
- **Do NOT score system-feed items eagerly for every user** (N users × items explosion) — score on demand per active user only.

---

## Phase 4 — Cross-system wiring

### 4a. Feed → podcast auto-gen
- Add `'feed'` to `podcastEpisodeSources.sourceType` enum (schema; SQLite won't enforce, Drizzle will).
- In `feeds/poller.ts`, after fresh items land, mirror `applySubscriptionAutomation` (`youtube/automation.ts:241`): find `podcastShows` where `autoGenerate=1 AND sourceRef='feed:'+feed.id`; call a new `createFeedEpisode` (model on `createYoutubeEpisode`, automation.ts:140 — content → script → episode). Source text = Phase 2 `contentHtml`.
- Podcast "add source" UI gains "From a feed" → sets `sourceRef='feed:<id>'`.
- **Gate hard:** off by default, per-show; prefer a "digest of N items" over per-item (LLM+TTS cost). Reuse the existing `isAutomationPaused` pause switch.

### 4b. Feed → briefing
- `backend/src/lib/briefing/settings.ts` has `sources: Record<BriefingSourceId, boolean>`. Add a `feeds` source id; in briefing refresh, pull top unread items from the user's feeds. Toggle in `AdminBriefingTab.tsx`. Additive, low risk.

### 4c. Saved searches as feeds
- `feeds.kind='search'` + `query`: poller branch for `kind='search'` calls `googleNewsSearch(query)` (already exported from `briefing/sources/rss.ts`) instead of fetching `url`. Dedup by `(feedId, guid=url)`.

### 4d. App registration (the small, real version)
- `AppItem` already added in Phase 1. Optionally add `'feeds'` to `APP_FEATURE_IDS` in `backend/src/routes/appFeatures.ts` (+ default maps ~lines 11, 21, 37) for an admin on/off toggle, plus a row in `AdminFeaturesTab.tsx`/`AdminAppsTab.tsx`.

### 4e. New-item notifications
- Reuse the `notifications` table (see `appStore.ts`, youtube `type:'yt-media'`). On fresh items for feeds the user enabled, insert `type:'feed-new'`. Gate behind `feeds.notify` (added in schema).

---

## Critical files reference

- `backend/src/db/schema.ts` + `backend/src/db/index.ts` — schema defs + authoritative inline `runMigrations()` SQL (**edit both together**).
- `backend/src/lib/youtube/feed.ts` — template for `lib/feeds/poller.ts`; `upsertSubscriptionVideos` dedup/batching pattern.
- `backend/src/lib/youtube/automation.ts` — template for feed→podcast auto-gen (`createYoutubeEpisode`, `applySubscriptionAutomation`, `isAutomationPaused`).
- `backend/src/lib/briefing/sources/rss.ts` — parser primitives to extract into `feeds/parse.ts`; export `WORLD_FEEDS` (seeding) and `googleNewsSearch` (Phase 4).
- `backend/src/lib/ogImage.ts` — fetch+cache+bounded-concurrency scaffold for `feeds/readability.ts`.
- `backend/src/lib/ssrfGuard.ts` — guard user-pasted URL fetches (verify export name).
- `backend/src/routes/news.ts` — absorption target (switch `world` to the store, keep `NewsItem[]` shape, live fallback).
- `frontend/src/lib/appCategories.ts` + `frontend/src/App.tsx` — app registration (catalog entry + route).
- `frontend/src/components/shared/NewsCard.tsx` — reuse `NewsFeature`/`NewsRow` for the Feeds list.
- `frontend/src/lib/news/useNews.ts` — react-query template for `lib/feeds/useFeeds.ts`.

## Suggested build order

1. Schema (both files) → 1a parser → 1c poller → 1d seed → 1e routes → 1g frontend → **1f News absorption last** (with fallback).
2. Phase 2 extractor + reader.
3. Phase 3 classifier.
4. Phase 4 wiring (podcast → briefing → search-feeds → registration/notifications).

Verify each phase against the live code before coding — several assumptions here were corrected once against reality and others may shift.
