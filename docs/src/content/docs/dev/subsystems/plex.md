---
title: Plex Integration
description: Per-user Plex linking atop a shared admin-configured server; library badges, watchlist/watched-status sync, and in-app direct-play for Shows and Movies.
sidebar:
  order: 22
---

## Overview

Plex sits on top of the existing Shows/Movies apps rather than being its own page. One admin-configured server connection is shared by the household; each user separately links their own Plex account so their watchlist and watched status stay personal, matching how Plex itself scopes them.

Engine lives in `backend/src/lib/plex/`. Exposed at `/api/plex` (`backend/src/routes/plex.ts`). Admin config UI is `AdminPlexTab.tsx`; the per-user link UI is `SettingsPlexTab.tsx`. `PlexBadge` and `PlexNowPlaying` are the two frontend surfaces that render on Shows/Movies detail and home pages.

## Connecting the server (admin)

`Admin → Plex`: either the plex.tv PIN flow (`lib/plex/auth.ts` requests a PIN, the admin approves it at plex.tv/link, the app polls and then auto-discovers reachable servers to pick from), or manual entry of a server URL + `X-Plex-Token`. Stored via `lib/plex/config.ts` as the shared/global connection.

## Linking a personal account

Each user links their own Plex account in `Settings → Plex` (`POST /api/plex/me/link`, `lib/plex/account.ts`), storing a per-user token. `getUserPlexConnection(userId)` resolves the shared server config plus that user's token for every subsequent call, so library reads use the shared server but watchlist/watched actions act as that specific Plex user.

## Videos → Plex library export (per source)

Each user can get private Plex libraries populated from their saved videos — one per content type (`youtube`, `tiktok`, `vimeo`, `reddit`, `mine`; see `lib/plex/export/contentTypes.ts`). YouTube rides the original exporter (`yt_plex_*` tables, SponsorBlock cutting); the rest share the generic exporter (`video_plex_*`, `lib/plex/export/genericSync.ts`). Setup, in `Admin → Plex`:

1. Connect the shared server and link the user's account (above).
2. Add a **storage location** (`AdminStorageLocationsTab.tsx`, `/api/admin/storage-locations`, `adminStorageLocations.ts`) pointing at a folder Plex can also reach, and assign it to the content types — this is what makes saves land there instead of the local data root.
3. Set that location's **Plex path mapping** (how Plex itself sees the same folder — often a different path than the app's own view of it, e.g. across a network share).
4. Call `POST /api/plex/admin/provision` (`{ userId, contentType }`), which enqueues `enqueuePlexProvision` (`lib/downloadJobs`) to create and populate the user's Plex library section. Status per user/contentType is tracked in `plexLibrarySections` and readable via `GET /api/plex/admin/library-sections`.

The admin UI checks storage-location + path-mapping readiness up front (`AdminPlexTab.tsx`, or the guided `PlexSetupWizard.tsx`) so "Provision" isn't clickable until both are actually set — otherwise the job fails with the error only visible server-side.

Per-library **policies** live on `plexLibrarySections` (`syncMode: all | recent` + `syncRecentCount`, and `removeWatched` — enforced by `lib/plex/export/policy.ts` and the 15-minute watched sweep in `watchedSweep.ts`, which detects watched via Plex view counts OR the app's own completed flag and then deletes the underlying save). Users tune their own libraries via `GET/PATCH /api/plex/me/library-sections` (the Videos settings "Plex sync" page, which also reports per-source `storageReady` so unprovisioned sources can explain what's missing).

## The two-ID-space problem

Plex identifies media by its own metadata GUIDs (IMDb/TVDB); MaiPai Home identifies shows by TVMaze id and movies by title+year. `lib/plex/resolve.ts` bridges the two: it extracts IMDb/TVDB GUIDs from a Plex item, resolves the matching TVMaze show id (falling back to title+year when GUIDs are missing), and returns an in-app route the existing `TitleCard` can render and click into. Resolutions are cached hard (30 days) since a Plex item's identity never changes. Movies key directly on title+year, no external lookup needed.

## What it adds

- **Plex badge** (`PlexBadge`): a "View on Plex" / "In your Plex" chip on Shows/Movies detail pages, backed by `GET /find`.
- **On Deck / Recently Added / Hubs** (`PlexNowPlaying`): rails on the Shows home page from `GET /ondeck`, `GET /recent`, `GET /hubs`.
- **Two-way watchlist**: `POST /watchlist` adds a title to the user's Plex watchlist from the app.
- **Watched-status sync**: `lib/plex/watched.ts` scrobbles app watch-progress to Plex and vice versa.
- **In-app direct-play**: movies only, via `GET /stream/:ratingKey`, a range-aware proxy (`Range` header passthrough for scrubbing) that forwards to the Plex server without ever exposing the token to the browser.
- **Poster/thumb proxy**: `GET /img` strips the token from Plex thumb URLs before they reach the client.

## Routes (`/api/plex`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/status` | Connection + link status for the caller |
| `GET` | `/find` | Resolve whether a title is in the user's library |
| `GET` | `/recent`, `/ondeck`, `/hubs`, `/sessions` | Library feeds |
| `GET` | `/img` | Token-stripping thumb proxy |
| `POST` | `/watchlist` | Add a title to the user's Plex watchlist |
| `GET` | `/meta/:ratingKey` | Item metadata by Plex rating key |
| `GET` | `/stream/:ratingKey` | Range-aware direct-play proxy |
| `POST` | `/auth/pin`, `GET` | `/auth/pin/:id` | plex.tv PIN-login flow |
| `GET` | `/me` | Caller's link status |
| `POST` | `/me/link` | Link the caller's Plex account |
| `DELETE` | `/me` | Unlink |
| `POST` | `/auth/discover` (admin) | Discover reachable servers for a linked plex.tv account |
| `GET`/`POST` | `/config` (admin) | Read/write the shared server connection |

## Failure mode

If Plex isn't configured, or a given user hasn't linked their account, every surface above degrades silently: badges and rails simply don't render, rather than showing an error.

## Status

Built atop the Shows/Movies badge system; not yet verified against a live Plex server in production use.
