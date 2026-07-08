---
title: API Reference
description: Backend HTTP API surface, organized by route group.
sidebar:
  order: 11
---

All routes are mounted under `/api` in `backend/src/index.ts`. The route handlers live in `backend/src/routes/` (one file per group, ~65 files). Most routes require authentication via the `requireAuth` middleware; admin-only routes use `requireAdmin`. A few setup/boot endpoints are intentionally unauthenticated because they run before a session exists.

This page groups routes by area rather than listing every endpoint. To see the exact handlers for a group, read the matching file in `backend/src/routes/`.

---

## Auth & session

`backend/src/routes/auth.ts`, mounted at `/api/auth`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/profiles` | List selectable profiles (no auth) |
| `POST` | `/api/auth/select` | Select a profile (no auth) |
| `POST` | `/api/auth/verify-pin` | Verify PIN, issue `session` cookie |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/auth/logout` | Invalidate session |

Sessions are HttpOnly cookies named `session`; the PIN is Argon2id-hashed (`Bun.password.hash`) with an HMAC pepper. See [Architecture](../architecture/) for the auth flow.

---

## Setup, boot & background jobs

| Group | Prefix | File | Notes |
|---|---|---|---|
| Setup wizard | `/api/setup` | `setup.ts` | `GET /status`, `POST /admin`, `GET /ollama-status`, `GET /catalog`, `POST /download` (**SSE**), `POST /welcome-complete`, `PUT /state` |
| System / boot | `/api/system` | `system.ts` | `GET /system/ready` (no auth, 503 until boot done), `GET /system/boot` (**SSE** boot + auto-repair stream) |
| Background jobs | `/api/jobs` | `jobs.ts` | `GET /status`, `POST /enqueue`, `POST /:id/retry`, `POST /:id/cancel`, `POST /retry-all-failed` |
| Feature flags | `/api/app-features` | `appFeatures.ts` | `GET /` (flags), `PUT /:id` (admin toggle) |
| App store | `/api/app-store` | `appStore.ts` | Install/uninstall apps & extensions |
| Notifications | `/api/notifications` | `notifications.ts` | User/admin notifications |

See [Boot & Feature System](../boot-features/) for the SSE event shapes.

---

## Chat, models & tools

| Group | Prefix | File | Notes |
|---|---|---|---|
| Chat | `/api/chat` | `chat.ts` | `GET /conversations`, `GET /conversations/:id`, `DELETE`/`PATCH /conversations/:id`, `POST /chat/stream` (**SSE** token stream) |
| Models | `/api/models` | `models.ts` | Ollama model list/select |
| Tools | `/api/tools` | `tools.ts` | Reactive tool config/invocation |
| Projects | `/api/projects` | `projects.ts` | Project grouping for conversations |
| Companions | `/api/companions` | `companions.ts` | Companion roster, favorites, grants |

---

## Image, vision & music

| Group | Prefix | File | Notes |
|---|---|---|---|
| Image generation | `/api/image` | `image.ts` | `POST /generate`, `GET /status` (**SSE** progress), `GET /loras`, `POST /enhance-prompt`, `POST /reference-face`, etc. (ComfyUI-backed) |
| Vision | `/api/vision` | `vision.ts` | VLM image analysis (structured JSON) |
| Music | `/api/music` | `music.ts` | Offline music-engine generation |

---

## Voice

| Group | Prefix | File | Notes |
|---|---|---|---|
| TTS | `/api/tts` | `tts.ts` | Streaming sentence-chunked TTS (NDJSON PCM) |
| STT | `/api/stt` | `stt.ts` | Whisper transcription (voice sidecar) |
| Voice | `/api/voice` | `voice.ts` | Voice config, wake-word model serving |

---

## Content, library & maps

| Group | Prefix | File | Notes |
|---|---|---|---|
| Library | `/api/archives` | `archives.ts` | ZIM archive list + kiwix-serve proxy |
| Maps | `/api/maps` | `maps.ts` | FTS geocoder, GraphHopper routing, pmtiles serving |
| Bookmarks | `/api/bookmarks` | `bookmarks.ts` | Personal + global bookmarks |
| Proxy | `/api/proxy` | `proxy.ts` | Bookmark/embed proxy (SSRF-guarded) |
| Content policy | `/api/content` | `content.ts` | Content-rating dials |
| Privacy | `/api/privacy` | `privacy.ts` | PIN-gated adult-content state |
| Home inventory | (see `home-inventory` routes) | `home.ts` | Device tracker, service log, warranties |
| Home layout | `/api/home-layout` | `homeLayout.ts` | Per-user home widget layout |
| Home Assistant | `/api/home-assistant` | `homeAssistant.ts` | Smart-home control via HA Assist |
| Videos (hub) | `/api/videos` | `videos.ts` | Source-parameterized browse/search/creators/saves over the provider registry (Reddit/TikTok/Vimeo/link) |
| Videos (YouTube source) | `/api/youtube` | `youtube.ts` | InnerTube search/browse, stream proxy, collections |
| Videos (stream cache) | `/api/vstream` | `videoStream.ts` | On-demand real-file streaming for PiP/mini-player |
| Podcasts | `/api/podcasts` | `podcasts.ts` | Show/episode generation + reverse-link |
| Shows | `/api/shows` | `shows.ts` | TV discovery, watchlist, progress, Plex badge |
| Movies | `/api/movies` | `movies.ts` | Film discovery, watchlist, Plex badge |
| Global search | `/api/search` | `search.ts` | Cmd+K unified provider registry (bookmarks/companions/devices/youtube/etc.) |
| Plex | `/api/plex` | `plex.ts` | Per-user linking, library feeds, watchlist/watched sync, direct-play proxy. See [Plex Integration](../subsystems/plex/) |

---

## Shopping, lookup & everyday tools

| Group | Prefix | File | Notes |
|---|---|---|---|
| Shopping | `/api/shopping` | `shopping.ts` | Price tracking, deals, coupons, photo identify. See [Shopping](../subsystems/shopping/) |
| Reverse Lookup | `/api/lookup` | `lookup.ts` | Property + people lookup (also backs the Maps residential panel) |
| File Converter | `/api/converter` | `converter.ts` | Image/audio/video conversion, SSE progress |
| Speed Test | `/api/speedtest` | `speedtest.ts` | Internet/server/server-internet throughput tests |
| Skills | `/api/skills` | `skills.ts` | Personal + shared companion instruction skills |
| Voice Memos | `/api/voice/memos` | `voiceMemos.ts` | Record, transcribe, list, delete |
| Notifications | `/api/notify` | `notifyChannels.ts` | Per-user channel routing + Telegram self-link code |

---

## Today / briefing data sources

Read-only data endpoints used by the Today/Home widgets and the daily-briefing system: `news.ts` (`/api/news`), `onThisDay.ts` (`/api/on-this-day`), `sports.ts` / `sportsToday.ts` (`/api/sports`, `/api/sports/today`), `joke.ts` / `jokes.ts`, `bored.ts`, `holidays.ts`, `localEvents.ts`, `tvShows.ts`, `whereToWatch.ts`, `recipes.ts`, `dictionary.ts`, `medical.ts`, `logo.ts`.

---

## Admin

Admin route groups live under `/api/admin/*` and require `requireAdmin`:

`adminInstall`, `adminUninstall`, `adminQueue`, `adminStorage`, `adminConnectivity`, `adminLocale`, `adminContent`, `adminMemory`, `adminCompanions`, `adminVoice`, `adminWakewords`, `adminImageLoras`, `adminArchives`, `adminMaps`, `adminBookmarks`, `adminBriefing`, `adminHomeAssistant`, `adminNotify` (Telegram bot token + SMTP config), `adminSpeedtest` (rating thresholds), `adminFrigate`, `adminNews`, plus the benchmark streams `adminChatBenchmark`, `adminRouterBenchmark`, and `adminLatencyTest` (each exposes an **SSE** `/stream`). This list groups by area rather than naming every admin route file; see `backend/src/routes/admin*.ts` for the full set.

---

## Static & docs

In production the backend serves the built SPA from `../frontend/dist` (`serveStatic`, with an `index.html` fallback for client routing) and the docs site from `../docs/dist` at `/docs/*`. In development the frontend runs on the Vite dev server (port 5173) and the backend allows it via CORS.
