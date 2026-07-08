---
title: "Videos: YouTube source"
description: "The YouTube plumbing inside the Videos app: InnerTube data, the yt-dlp privacy stream proxy, SponsorBlock, subscriptions/feeds, offline saves, and the video-to-podcast bridge."
sidebar:
  order: 7
---

import { Aside } from '@astrojs/starlight/components';

The YouTube source inside the multi-source [Videos hub](../videos/). It predates the hub and keeps its own richer plumbing (`yt_*` tables, `/api/youtube` routes); the hub reaches it through a thin provider adapter (`lib/videos/providers/youtube.ts`) — wrap, never rewrite.

A keyless, account-free YouTube integration that never lets the browser talk to Google. Data comes from YouTube's internal `youtubei/v1` (InnerTube) API and privacy front-ends; playback streams through a server-side proxy that resolves a direct CDN URL with `yt-dlp` and proxies the bytes. Everything else (thumbnails, SponsorBlock, transcripts) is proxied too.

Key files:

- `backend/src/routes/youtube.ts`: every HTTP endpoint.
- `backend/src/lib/youtube/innertube.ts`: the InnerTube client (`innertubeSearch`, `innertubeChannel`, `innertubeRelated`, `innertubePlayerMeta`, `innertubePlaylist`, `innertubeSearchMore`).
- `backend/src/lib/youtube/discovery.ts`: `fetchPopular` / `fetchTrending` via Invidious/Piped, plus `enrichChannelThumbs`.
- `backend/src/lib/youtube/stream.ts`: `resolveStreamUrl` (the `yt-dlp -g` resolver + URL cache).
- `backend/src/lib/youtube/ytdlp.ts`: the managed `yt-dlp` binary (version check, auto-update, concurrency slot via `withYtDlpSlot`).
- `backend/src/lib/youtube/sponsorblock.ts`: `getSkipSegments`.
- `backend/src/lib/youtube/feed.ts`, `resolve.ts`, `transcript.ts`, `summarize.ts`, `download.ts`, `durations.ts`, `quality.ts`.
- `frontend/src/pages/youtube/`: `YoutubeHomePage`, `WatchPage`, `YoutubeChannelPage`, `YoutubeSubscriptionsPage`, `YoutubeLibraryPage`, `YoutubeShortsPage`, `YoutubePlaylistPage`.

All routes mount under `/api/youtube` and require `requireAuth`.

## Data Source: InnerTube First, Privacy Front-ends as Fallback

There is no YouTube Data API key. Search, channel pages, related videos, playlists, and per-video player metadata all come from InnerTube. `tryInnertube(label, fn, fallback)` and `tryInnertubeRetry(...)` wrap calls so a failure degrades to a fallback shape rather than throwing.

<Aside type="note">
YouTube retired its anonymous Trending page (`FEtrending` now 400s). The `/popular` and `/trending` shelves therefore aggregate from privacy front-ends in `discovery.ts`: **Popular** = Invidious `/popular` (most-watched, reliable); **Trending** = Piped (thinner and flakier, may be empty, in which case the UI hides the shelf). These are best-effort and cached.
</Aside>

## The Privacy Stream Proxy

This is the core of the privacy guarantee. `GET /stream/:videoId?kind=&q=`:

1. Validates the id (`isValidVideoId`, exactly 11 chars of `[A-Za-z0-9_-]`) before shelling out, so a crafted id can't steer `yt-dlp` at another extractor.
2. Calls `resolveStreamUrl(videoId, kind, quality)` (`stream.ts`), which runs `yt-dlp -f <format> -g` to get a direct `googlevideo.com` URL. `yt-dlp` does the hard part: solving the signature cipher and the `n`-parameter throttle. Resolved URLs are cached for `TTL_MS` (4h, though the googlevideo `expire` is shorter) and IP-locked to the server.
3. Fetches the upstream with `Range` passthrough so the `<video>` element can seek, combining a client-disconnect `AbortSignal` with a 30s timeout.
4. On a `403` (rotated signature), drains the body, calls `invalidateStreamUrl`, re-resolves once, and refetches.
5. Forwards only `content-type`, `content-length`, `content-range`, `accept-ranges`.

<Aside type="caution">
`isAllowedUpstream` in `stream.ts` only ever proxies `*.googlevideo.com` / `*.youtube.com`. This is the SSRF guard: the resolver's output is never trusted as an arbitrary fetch target. Do not loosen it.
</Aside>

Progressive (muxed) MP4 only goes to 720p on YouTube; higher resolutions are split DASH streams a plain `<video>` can't play without muxing. So `StreamQuality` is `'auto' | '720' | '360'`, mapping to itags 22/18. Audio mode pulls `bestaudio[ext=m4a]`.

## SponsorBlock

`GET /sponsorblock/:videoId` proxies `getSkipSegments` (`sponsorblock.ts`), which hits the public `sponsor.ajay.app` API for `skip`-type segments across `sponsor`, `selfpromo`, `interaction`, `intro`, `outro`, `preview`, `music_offtopic`. Proxied server-side so the third party never learns which videos the user watches. A `404` ("no segments submitted") is the common non-error case and returns `[]`.

## Thumbnails

`GET /img?u=<url>` re-serves YouTube/ggpht/googleusercontent images same-origin (host-allowlisted, HTTPS only). This keeps the browser from contacting Google and lets thumbnails be drawn onto a `<canvas>` (podcast covers) without tainting it.

## Subscriptions and Feeds

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/subscriptions` | The caller's subscriptions. |
| `POST` | `/subscriptions` | Resolve an input (URL/handle/id) via `resolveYouTubeInput` and add it; kicks off `refreshSubscriptionFeed`. |
| `POST` | `/subscriptions/import` | Import a Google Takeout CSV (`parseTakeoutCsv`). |
| `DELETE` | `/subscriptions/:id` | Remove; drops the shared `yt_channel_cache` only once nobody follows the channel. |
| `POST` | `/subscriptions/:id/refresh` | Re-poll one channel's RSS feed. |
| `POST` | `/subscriptions/refresh-all` | Re-poll all of the user's feeds. |
| `GET` | `/feed` | Merged newest-first feed across the user's subs (paged). |

Tables: `yt_subscriptions`, `yt_videos`. The feed query matches videos by `subscriptionId` **or** by `channelId` (a channel sub's `externalId` is the video's `channelId`), so videos inserted by non-poller paths (watch history, search) still surface under the right sub. RSS feeds omit durations, so `POST /durations` lazily backfills them with `yt-dlp` (id + duration only, no media) to split Shorts from regular videos.

## Offline Saves and Device Downloads

Two distinct features:

- **Save (offline library):** `POST /save` (alias `/download`) enqueues a `yt-media` job in the durable `download_jobs` queue (`domain: 'youtube'`, `sizeClass: 'large'`). Audio is best-quality; video is clamped to `getEffectiveCap(userId)` = `min(admin global/per-user cap, user preference)`. Quality tiers live in `quality.ts` (`SAVE_HEIGHTS`); the picker is `GET /save-quality`; admin caps are `GET/PUT /admin/limits[/...]`. Files are served from `GET /file/:videoId/:kind` with Range support; tracked in `yt_downloads`.
- **Download to device:** `GET /formats/:videoId` lists `yt-dlp` formats, `POST /export` enqueues a `yt-export` job, the client polls `GET /export/:jobId`, and `GET /export/:jobId/file` hands the file over once with `Content-Disposition: attachment` then deletes the temp file.

`GET /admin/ytdlp` and `POST /admin/ytdlp/check` expose `yt-dlp` binary health and force an update check.

## Transcripts, Summaries, Metadata

| Path | Purpose |
|---|---|
| `GET /transcript/:videoId` | Timed VTT captions (download-local first, else fetched live via `ensureTranscript`). |
| `GET /transcript-text/:videoId` | Cleaned plain-text transcript for the "Read transcript" modal. |
| `GET /video/:videoId` | DB-first metadata; falls back to `innertubePlayerMeta`, then `yt-dlp -J`. Fires `ensureTranscript` + `ensureSummary` in the background (idempotent). |
| `POST /summarize/:videoId` | LLM summary from captions (`ensureSummary`). |

## Discovery, History, Watch State, Collections

| Path | Purpose |
|---|---|
| `GET /popular` / `GET /trending` | Discovery shelves (Invidious/Piped, see Aside above). |
| `GET /channel/:channelId` | Full channel uploads, paged off InnerTube `continuation`. First page cached in `yt_channel_cache` (30 min TTL); stale cache is served if a live fetch fails, so a channel is never shown empty. |
| `GET /related/:videoId` | Real "Up next" via `innertubeRelated`. |
| `GET /recommended` | Seeds `innertubeRelated` with recently-watched ids (falling back to recent sub uploads, then popular), merges, dedupes, excludes watched. |
| `GET /playlist/:playlistId` | A playlist's videos. |
| `GET /history` | Watch history from `yt_watch_state` joined to `yt_videos`. |
| `POST /watch-state` | Upsert resume position/`completed`; records a minimal `yt_videos` row on first sight so search/related plays land in History. |
| `GET/PUT/DELETE /collections[/:key/:videoId]` | Server-backed Watch Later / Liked (`yt_collections`); the client mirrors them into localStorage for instant render. |

## YouTube → Podcast Bridge

`POST /podcast` fans a selection (explicit `videos[]`, or a `subscriptionId`'s recent uploads) into one podcast episode **per video**. It resolves a target show (existing owned show, a new show, or the auto per-user "YouTube Digest" show via `ensureDigestShow`), skips videos already turned into episodes in that show (so repeated calls walk the back-catalogue), and for each target inserts a `podcast_episodes` row plus a `podcast_episode_sources` row (`sourceType: 'youtube'`) and enqueues a `podcast-generate` job whose payload carries a per-episode `youtube` segment override scoped to that one video.

The reverse link is `GET /api/podcasts/by-video/:videoId` (in `podcasts.ts`), which powers the "Featured in podcasts" shelf on the watch page. `POST /digest` is a separate, lighter text-only digest of recent subscription uploads.

## Regression Notes

| Symptom | Likely cause |
|---|---|
| Video won't play / `502` from `/stream` | `yt-dlp` missing or outdated (check `/admin/ytdlp`); signature solve failed. |
| Plays then dies after a few hours | googlevideo URL expired; the `403` re-resolve path didn't fire. |
| Trending shelf empty | Expected when Piped returns nothing; the UI hides it. Popular (Invidious) is the reliable one. |
| Channel page empty | Live InnerTube fetch failed and no cache existed yet; retries via `tryInnertubeRetry`. |
| Thumbnails broken on podcast covers | The `/img` proxy bypassed (cross-origin canvas taint). |
