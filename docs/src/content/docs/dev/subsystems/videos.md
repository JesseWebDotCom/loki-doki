---
title: Videos (multi-source hub)
description: "The provider registry that unifies YouTube, Reddit, TikTok, Vimeo, and pasted links: capabilities, follows/feeds, offline saves and rules, playback negotiation, and Plex export hooks."
sidebar:
  order: 6
---

The Videos app (`/videos`) is a hub over a **provider registry**: each source implements one `VideoProvider` interface and the hub's surfaces (mixed home, search, creator pages, watch page, offline library) are written once against it. YouTube is the odd one out — it predates the hub and keeps its own richer plumbing (see [YouTube source](../youtube/)); its provider is a thin adapter over that stack.

Key files:

- `backend/src/lib/videos/provider.ts`: the `VideoProvider` interface + `ProviderCapabilities`.
- `backend/src/lib/videos/registry.ts`: provider registration, URL matching, enabled-source config.
- `backend/src/lib/videos/providers/`: `youtube.ts` (adapter), `reddit.ts`, `tiktok.ts`, `vimeo.ts`, `link.ts`.
- `backend/src/routes/videos.ts`: the source-parameterized API (`/api/videos/:source/...`).
- `backend/src/routes/videoStream.ts`: `/api/vstream/:source/:id` — on-demand real-file streaming for PiP/mini-player.
- `backend/src/lib/videos/feed.ts`: the follows poller + auto-save automation; `offlineSweep.ts`: remove-once-watched.
- `backend/src/lib/videos/download.ts`, `quality.ts`, `enhance.ts`, `smartTitle.ts`.
- `frontend/src/pages/videos/`, `frontend/src/components/videos/`.

## Capabilities, not special cases

`ProviderCapabilities` declares what each source can do — `browse`, `search`, `creators`, `comments`, `live`, `playlists`, `related`, `transcript`, `downloadKinds`, `authConfig` — and the frontend gates UI on those flags instead of switching on source names. A provider without `search` never shows in the search picker; one with `transcript: false` (TikTok, Reddit) hides the Transcript/AI Summary tabs; `downloadKinds` drives the save-as video/audio toggle. Discovery rankings (`popular`/`trending`) are declared separately, and `resolveDiscovery()` lets a source withdraw them when unconfigured (Reddit without a client id, keyless Vimeo).

## Playback negotiation

`getPlayback(id)` returns a `PlaybackInfo` union — `native-app` (YouTube's own watch page), `embed` (TikTok/Vimeo iframes), `hls` (Reddit's v.redd.it through a manifest proxy), `proxy-progressive`, or `file` — and the watch page renders whichever player fits. Embeds can't do PiP or the mini player, so `/api/vstream/:source/:id` downloads a real H.264 file once (yt-dlp, or an ffmpeg HLS remux for Reddit) into a cache and serves it with Range support; PiP and minimize hand off to that.

## Follows, feeds, and offline rules

`video_follows` mirrors `yt_subscriptions` for the other sources (one row per user+source+creator, with the same `autoSave` / `autoSaveKind` / `autoSaveKeep` / `removeWatched` policy columns). The 15-minute poller (`feed.ts`) refreshes `video_items` per follow, auto-saves genuinely-new uploads for opted-in follows, and prunes each creator's auto-saved rows to keep-N (ordered by real upload date; manual saves are exempt). `offlineSweep.ts` runs on the same tick for both table families and deletes auto-saved copies once the app's own `completed` watch flag has settled — the follow-level counterpart of the Plex library's `removeWatched` policy, with union semantics between the two.

The "Configure for offline" popover (`ConfigureOfflinePopover.tsx`) is the one UI for all of this on both YouTube channels and generic creators; enabling it backfills the latest keep-N via `POST /api/videos/:source/creator/:id/save-now` (or YouTube's `/channel/:id/save-now` with `auto: true`).

## Saves and the shared blob store

`video_saves` rows are per-user references onto shared `media_assets` keyed `(source, videoId, kind, format)` — two household members saving the same TikTok share one blob, and a save whose asset already exists attaches instantly with no download. Downloads run as durable `video-media` jobs (yt-dlp, or ffmpeg for HLS), honor per-source quality caps (`quality.ts`, admin ceiling ∧ user preference), and can be re-encoded to a crisper rendition in the background (`enhance.ts`, per-user per-source opt-in).

## Cross-source library

Watch Later / Liked live in `yt_collections` with a `videoSource` column (plus a thumbnail snapshot for non-YouTube rows); history merges `yt_watch_state` and `video_watch_state`; playlists carry `videoSource` per entry. The shared render layer — `CreatorAvatar` (host-sniffing image proxy pick), `cardParts.tsx` (meta block, badges, save button), `lib/youtube/format.ts` formatters — is what every card and row goes through, for YouTube and hub sources alike.

## Plex export

Every source exports to per-user private Plex libraries through the generic exporter (`video_plex_*` tables); YouTube keeps its original exporter (`yt_plex_*`, SponsorBlock cutting). Policies (`all`/`recent-N`, `removeWatched`) live on `plex_library_sections`. See [Plex](../plex/).
