---
title: Today & Daily Briefing
description: The Home dashboard data flow, the customizable home layout (per-user + admin default + lock), the warm briefing cache and its sources, and the reactive chat tools.
sidebar:
  order: 9
---

import { Aside } from '@astrojs/starlight/components';

This page covers the "Today" subsystem: the Home dashboard and its widgets, the customizable layout (per-user, admin default, and lock), and the ambient **daily briefing** that flavors the companion. The briefing sources and the dashboard widgets share the same upstream feeds, so they are documented together.

## Two Halves

There are two things often conflated here, and they are distinct:

1. **The Home dashboard** (`frontend/src/pages/HomePage.tsx`): a customizable widget grid the user sees on the Home page. Each widget calls its own public route on demand.
2. **The daily briefing** (`backend/src/lib/briefing/`): a warm, server-side cache of ambient world/local context that is woven into the **companion** system prompt. The user never sees the briefing block directly.

They draw on overlapping data (weather, news, sports, on-this-day, holidays) but along entirely separate paths.

<Aside type="note">
`backend/src/routes/home.ts` is **not** the dashboard. It is the home-inventory device API (`/api/home/devices/...`). The dashboard layout lives in `backend/src/routes/homeLayout.ts`.
</Aside>

## The Home Dashboard

### Widget catalog

**File:** `frontend/src/lib/homeWidgets.ts`. `HOME_WIDGETS` is the single source of truth for every real widget. The picker, the placed-widget chrome, and the admin editor all read from it; a widget only exists if it has an entry, which is what keeps the picker from ever offering a "coming soon" tile. Current entries:

| Widget id | Title | `toolId` (gate) | `allowWide` |
|---|---|---|---|
| `weather` | Weather | `weather` | yes |
| `news` | News | `news` | yes |
| `sports` | Scores | `sports` | yes |
| `on-this-day` | On This Day | `onthisday` | yes |
| `jokes` | Joke of the Day | `jokes` | no |

`toolId` gates availability against `/api/tools`: if the backing tool is not installed/enabled for the user, the widget is not offered. `canonicalWidgetId()` resolves legacy stored ids through an `ALIASES` map (`onthisday` → `on-this-day`).

### Rendering and drag-drop

`HomePage.tsx` holds the renderers (`WIDGET_RENDERERS`) and the canvas logic itself; there is no separate `pages/home/` dashboard module (that directory holds home-inventory modals). The header renders three optional pieces (compact weather, a joke line, a sports ticker) plus an auto-injected top-headline pair and an "On This Day" card. The canvas is a grid of rows of at most two widgets, edited with `@dnd-kit/core`:

- Drop targets are `row:{rowId}` (pair into an existing solo widget), `gap:{rowId}` (insert a new row before), and `gap:end` (append).
- Edits live in local draft state and are committed via the layout hook's `save()`; cancel discards the draft.

### Each widget's data

Every widget calls a public route on demand. All are internet-backed except where noted; offline responses carry an explicit `offline: true` flag and the UI degrades gracefully.

| Widget / page | Route | Upstream | Offline |
|---|---|---|---|
| Weather | `/api/weather`, full page `/api/tools/weather/...` | Open-Meteo | cached |
| News | `/api/news?type=world\|local&limit=N` | NYT/Guardian/BBC RSS (world), Patch + Google News RSS (local) | empty + `offline` |
| Sports ticker | `/api/sports/today` | ESPN | `games: [], offline` |
| Sports page | `/api/sports?league=...` | ESPN | `games: [], offline` |
| On This Day | `/api/on-this-day` | Wikimedia | empty + `offline` |
| Jokes | `/api/jokes`, `/api/jokes/fresh` | icanhazdadjoke / jokes tool | `joke: null` |
| Holidays | `/api/holidays?country=&year=` | Nager.Date, falls back to a fixed US table | offline US only |
| Local events | `/api/local-events` (`?bust=1`) | Patch (with consent + userId) or Google News RSS | empty |
| Moon phase | none | pure client-side math | fully offline |

News (15 min), sports (15 min), on-this-day (per-day), jokes (per-day), holidays (24 h), and local events (15 min, per-user) cache in-memory in their route modules. News uses a stale-while-revalidate strategy.

## The Customizable Layout

**File:** `backend/src/routes/homeLayout.ts`. Layout is a `{ header, canvas }` shape stored as JSON, capped at 64 KB.

```typescript
interface HomeLayoutHeader { weather: boolean; jokes: boolean; sports: boolean; locked: boolean }
interface HomeWidget { toolId: string; colSpan: 1 | 2 }
interface HomeRow { id: string; cols: HomeWidget[] }
interface HomeLayout { header: HomeLayoutHeader; canvas: HomeRow[] }
```

Three storage keys back the whole system:

- `home.layout`: the **per-user** layout (`userPreferences`, keyed by `userId`).
- `home.layout.default`: the **admin default** layout (`appSettings`), served to any user without a saved layout.
- `home.layout.locked`: a per-user boolean (`userPreferences`); when `true` the user's `PUT` is rejected `403` and the client hides Edit.

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/home-layout` | `requireAuth` | The caller's effective layout + `locked` flag. |
| `PUT` | `/api/home-layout` | `requireAuth` | Save the caller's layout (rejected `403` if locked). |
| `GET` | `/api/home-layout/default` | `requireAdmin` | Read the system default. |
| `PUT` | `/api/home-layout/default` | `requireAdmin` | Set the system default. |
| `GET` | `/api/home-layout/users/:userId` | `requireAdmin` | Inspect a user's layout + lock. |
| `PUT` | `/api/home-layout/users/:userId` | `requireAdmin` | Set a user's layout and/or lock (`{ layout?, locked? }`; validates the user exists first to turn an FK violation into a clean 404). |

`GET /api/home-layout` resolves the effective layout as `userLayout ?? systemDefault`, and always overlays the live `locked` value onto `header.locked`. If the user has no saved layout but has a legacy `home.highlights` preference (`{ sports?, jokes? }`), it migrates those booleans into the default header once on read.

## The Daily Briefing

**Directory:** `backend/src/lib/briefing/`. The briefing is ambient context injected into the companion, warm-cached so the request path never blocks on a fetch.

### Cache

**File:** `cache.ts`. An in-memory `Map` keyed by location `displayName` (or `DEFAULT_BRIEFING_KEY` for the boot default), LRU-evicted at 32 entries. Each entry is `{ payload, block, expiresAt }`, where `block` is the rendered prompt string. TTL is `BRIEFING_TTL_MS` (2.5 h). `peekCachedBriefing()` returns even-expired entries for admin inspection; `getCachedBriefing()` honors expiry.

### Refresh

**File:** `refresh.ts`. `startBriefingRefresh()` warms the default location at boot, then ticks every `TICK_MS` (5 min), re-refreshing any entry older than the admin-configured `cadenceMinutes` (default 150). `refreshBriefing()` fans out to all enabled sources with `Promise.allSettled`; any failures land in a `degraded[]` list and are tolerated. `ensureBriefingWarm(cacheKey, location?, userId?)` is the fire-and-forget lazy path: it returns immediately if the entry is fresh and otherwise kicks a background refresh (coalescing concurrent calls). **None of this runs on the companion request path.**

### Render budget

**File:** `render.ts`. `renderBriefingBlock()` produces a `[Local context ...]` header block (with location and date) under a hard `CHAR_CAP` of 700 (~180 tokens), then appends a single weave-in instruction telling the model to use the context only when genuinely relevant and never to recite it unprompted. When over budget it trims least-important sources first (notable deaths, on-this-day, sports, then world/local news and events).

### Sources

**Directory:** `backend/src/lib/briefing/sources/`. The manifest in `types.ts` enumerates each toggleable source:

| Source id | Upstream |
|---|---|
| `weather` | Open-Meteo (+ geocoding) |
| `worldNews` | NYT / Guardian / BBC RSS |
| `localNews` | Google News RSS, Patch (with consent) |
| `localEvents` | Google News RSS |
| `sports` | ESPN |
| `onThisDay` | Wikimedia |
| `notableDeaths` | Google News RSS |
| `holidays` | Nager.Date |

### Injection into the companion

The briefing is **not** wired into `chat.ts`. It reaches the user through the companion endpoint, `backend/src/routes/companions.ts`:

```typescript
const briefingKey = locStr ?? DEFAULT_BRIEFING_KEY
const briefingBlock = offlineMode ? null : (getCachedBriefing(briefingKey)?.block || null)
if (!offlineMode) ensureBriefingWarm(briefingKey, /* location */, user.id)
// ...
const sys = [contentPrompt, personaIntro, persona, candorFragment,
             body.uiContext, memoryBlock, briefingBlock].filter(Boolean).join('\n\n')
```

The read is **synchronous** (a warm-cache lookup, never an `await`/fetch) so it does not touch the `[COMPANION-TIMING]` budget. Because the block only changes on the cadence, the system-prompt prefix stays stable across turns, preserving Ollama's KV cache. In offline mode the block is `null` and `ensureBriefingWarm` is skipped entirely.

### Admin

**File:** `backend/src/routes/adminBriefing.ts`. Settings live in `appSettings` under the `briefing.` prefix (`enabled`, `cadence_minutes`, `patch_slug`, `default_location`, `source.*`, `max_items.*`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/briefing` | Current settings + a cache snapshot (per-location `generatedAt`, degraded sources, block size). |
| `PUT` | `/api/admin/briefing` | Upsert one setting. |
| `POST` | `/api/admin/briefing/refresh-now` | Force a refresh for a location and return the rendered block. |

## Reactive Chat Tools

The briefing is the *ambient* path. The same feeds are also available *reactively* as tools the router can call when the user asks directly (see the chat subsystem for routing). These live in `backend/src/tools/` and are all `offline: false`:

| Tool id | Does | Upstream |
|---|---|---|
| `onthisday` | Historical events/births for a date (defaults to today) | Wikimedia |
| `localEvents` | Local events near the user | Patch (consent + userId) or Google News RSS |
| `localNews` | Hyperlocal town headlines | Patch (consent + userId) or Google News RSS |
| `sports` | Today's scores across MLB / NFL / NBA / NHL / MLS / World Cup | ESPN |
| `contentRating` | Parental guidance for a title | Common Sense Media (scrape), falling back to a local-LLM rating |

`contentRating` is notable: when its scrape path is unavailable it degrades to a local Ollama rating (`source: 'ai'`) rather than failing, so it still answers offline-ish.

## Common Regression Patterns

| Symptom | Likely cause |
|---|---|
| Companion never references the day | `briefingBlock` null: offline mode on, or the cache never warmed (`startBriefingRefresh` not started). |
| Companion timing regressed | A briefing read became an `await`/fetch instead of the synchronous warm-cache lookup. |
| Briefing block too long / noisy | `CHAR_CAP` raised, or the trim order in `render.ts` changed. |
| Widget missing from the picker | No `HOME_WIDGETS` entry, or its `toolId` gate is disabled for the user. |
| User can still edit a locked layout | `home.layout.locked` not read, or the `PUT` 403 not enforced. |
| Stale dashboard data | A route's in-memory TTL bypassed, or `offline` flag not surfaced to the widget. |
