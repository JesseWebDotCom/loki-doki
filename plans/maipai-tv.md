# MaiPai TV: linear family channels plan

A full linear-TV experience inside MaiPai Home: numbered channels, a guide, channel surfing,
commercials, bumpers, and dayparts, in the spirit of ErsatzTV / DizqueTV / Tunarr, but
built on everything the app already knows about the household (media libraries, cameras,
calendar, locations, homelab, AI production pipeline). Channels play on demand: nothing
streams until someone tunes in, and tune-in lands "mid broadcast" like real TV.

No em dashes anywhere in this doc (house rule).

## The core architectural insight: two output paths, one scheduler

ErsatzTV must transcode everything into one MPEG-TS/HLS stream because its only client is
Plex. We own our client. So MaiPai TV splits into:

**Path A: the native in-app player (primary, Phase 0).** The frontend `/tv` app asks the
backend "what is channel 4 showing right now, and at what offset", then plays the
underlying source directly: a `<video>` element seeked into a Plex/local/YouTube item, an
HLS `<video>` for a live camera, a mounted React component for a dashboard channel, or
audio plus `AudioVisualizer` for a music channel. Zero transcode cost, instant channel
change, and the "linear TV" illusion comes entirely from the scheduler. This is how 90% of
viewing happens (browser, desktop app, PWA, pods).

**Path B: the real stream engine (later phase).** An on-demand ffmpeg pipeline that muxes
any channel into live HLS for clients we don't control: TVs, Chromecast (`lib/cast/`),
Plex/Jellyfin via IPTV (M3U + XMLTV), and any dashboard channel that must become "real
video" (rendered by headless Chromium and screen-captured into the encoder). A session
spins up on first tune-in and tears down after idle.

Both paths read the same schedule, so a phone in the app and the living-room TV on the
transcoded stream show the same program at the same moment.

## Scheduling engine

**A channel is config plus a schedule, not a playlist.** Channel config declares
programming rules (content sources, ordering, dayparts, filler policy). A nightly
scheduler job materializes the next 24-48h into a `tv_schedule` table: concrete blocks
with absolute start/end times. Materializing (instead of computing on the fly) gives us:

- an EPG the guide and the Prevue channel can query cheaply
- a coordination point for the AI pre-render pipeline (segments are generated against
  tomorrow's schedule, and a block only airs if its asset is `ready`, else filler)
- deterministic join-in-progress: tune-in = look up the row covering `now()`, offset =
  `now - startAt`

**Block kinds** (the renderer registry keys off this):

| kind | payload | Path A renderer | Path B input |
|---|---|---|---|
| `media` | Plex/local/YouTube/podcast item + offset | `<video>`/audio player | ffmpeg file/URL input |
| `live` | HLS/RTSP URL (camera, ISS, webcam, radio) | HLS video / audio | ffmpeg restream |
| `page` | route of a dashboard channel screen | mounted React component | Chromium capture |
| `segment` | pre-rendered AI mp4 from `tv_segments` | `<video>` | ffmpeg file input |
| `audio` | track/podcast/station + visualizer scene | audio + `AudioVisualizer` | Chromium capture |

**Filler and interstitials.** Every channel schedules to whole-minute boundaries and fills
gaps from a pool: channel idents/bumpers, AI commercials, promos for upcoming programs,
"coming up next" cards. This is what makes it feel like TV instead of a shuffled playlist.

**Dayparting.** Channel config carries daypart rules (cartoons until 9am, ambient during
school hours, movies at night, sign-off at bedtime). Kids' channel bedtime blocks respect
the existing family audio policy (`lib/family/audioPolicy.ts`) so TV and audio limits
agree.

## The on-demand stream engine (Path B)

- `GET /api/tv/stream/:channel/index.m3u8` lazily creates a `ChannelStreamSession`:
  one supervisor per channel that walks the schedule and feeds ffmpeg
  (`lib/ffmpeg.ts` resolver, already auto-downloads a static build) block by block,
  writing live HLS (2s fmp4 segments, sliding window) into `data/cache/tv/<channel>/`.
- Block transitions restart the encoder input and emit `EXT-X-DISCONTINUITY` (the
  simple, reliable approach; a persistent-encoder pipe is an optimization later).
  Target under 5s from tune-in to first frame.
- `page` and `audio` blocks render in headless Chromium (`lib/playwrightEnv.ts`, same
  runtime as the reader/PDF engine) pointed at an unauthenticated-local-only render
  route (`/tv/render/:channel`), captured via CDP screencast into ffmpeg.
- Sessions refcount viewers (playlist polling = liveness) and tear down after ~60s idle.
  Concurrent-session cap and encoder settings live in admin config; hardware encode when
  the GPU stack (`adminGpu.ts`, `vramLedger.ts`) says there's headroom, x264 veryfast
  otherwise. TV transcode must yield to LLM/image-gen loads via `resourceMode.ts`.
- IPTV surface: `/api/tv/iptv/playlist.m3u` + `/api/tv/iptv/guide.xml` (XMLTV). Jellyfin
  and most IPTV apps consume this directly. Plex Live TV needs an HDHomeRun tuner
  emulation layer (what ErsatzTV does); treat that as a stretch item inside this phase.

## AI segment production pipeline

AI channels are **pre-rendered, never generated live**. A `tv-segment` job type in the
existing job queue (`downloadJobs.ts` / `genQueue.ts`) runs after the nightly scheduler:
script via the LLM pipeline, voice via Kokoro TTS (`voice-server`), stills via ComfyUI,
composited to mp4 by the videostudio render pipeline (`lib/videostudio/render`, `edl.ts`),
stored in `tv_segments` with `airDate`. The briefing engine (`lib/briefing/`, already
fetches and summarizes local news) is the content source for news segments. Every AI
segment surface carries `AiGeneratedBadge` in Path A and a rendered "AI" bug in Path B,
and safety-relevant content (camera alerts) is never rewritten, per the house AI-labeling
rule.

## Data model (new tables)

```
tv_channels   id, number (int, unique), slug, name, icon, color, kind, config (JSON),
              enabled, createdAt
tv_schedule   id, channelId, startAt, endAt, blockKind, title, payload (JSON),
              segmentId (nullable)
tv_segments   id, channelId (nullable: shared pools like ads), kind, status
              (pending|rendering|ready|failed), path, durationSec, airDate, meta (JSON)
tv_watch      id, userId, channelId, startedAt, endedAt   (optional, powers "continue"/stats)
```

Ad/bumper pools are `tv_segments` rows with `channelId = null` and `kind = 'ad' | 'bumper'`.

## Channel catalog

Numbers are suggested dial positions. "Infra" cites what already exists in the repo.

### Media library channels (block kind: media)

| # | Channel | What it shows | Infra |
|---|---|---|---|
| 2 | Doki Movies | Plex movie library: genre nights, decade blocks, Friday premieres | `lib/plex/resolve.ts`, `routes/movies.ts` |
| 3 | Doki Movies 2 | Second movie feed (family-safe daypart, horror after midnight) | same |
| 4 | Marathon | One Plex show back-to-back, rotates weekly, viewer-votable | `routes/tvShows.ts`, `shows.ts` |
| 5 | Shuffle TV | Random episodes across the whole show library, sitcom-block style | same |
| 6 | Creators | Lineups built from subscribed YouTube channels | `lib/youtube/stream.ts`, `ytdlp.ts` |
| 7 | Music Video | MTV-style, split by era dayparts (80s mornings, 2000s nights) | YouTube stack |
| 8 | Longplays | Retro game longplays, ambient background gold | YouTube stack |
| 9 | Public Access | Videos the family uploaded: school events, game recordings, kid films | `lib/capture/organize.ts`, uploads |
| 10 | Memories | Ken Burns photo slideshows: "this week in 2019", trips, year-in-review | iCloud photos (`lib/icloud/`) |

### Audio channels (block kind: audio, visualizer video)

| # | Channel | What it shows | Infra |
|---|---|---|---|
| 11 | MaiPai FM | Music stations with `AudioVisualizer` scenes, AI DJ talkover interstitials | music stack, `musicRadio.ts` |
| 12 | Live Radio | Real internet radio streams | `musicRadioLive.ts` |
| 13 | Podcast Network | Subscribed podcasts on a schedule, artwork + chapter cards on screen | podcasts stack |
| 14 | Doki Originals | The household's AI-generated podcasts | `podcastAi.ts` |

### Live channels (block kind: live)

| # | Channel | What it shows | Infra |
|---|---|---|---|
| 20-2x | Cam 1..N | One channel per Frigate camera, event overlays | `lib/frigate/`, `routes/frigate.ts` |
| 28 | Security Desk | Multi-cam grid page with recent Frigate events ticker | Frigate + `page` block |
| 29 | Pet Cam | The pet's camera, optional AI color commentary segments | Frigate + segment pipeline |
| 30 | The Window | Rotating scenic public webcams (beach, mountains, city square) | new: curated URL list |
| 31 | Space | ISS live feed, launches, astronomy picture of the day | new: public feeds |
| 32 | Fireside | Fireplace/aquarium/rain loops, seasonal rotation | local looped files |

### Dashboard channels (block kind: page; React screens, captured for Path B)

| # | Channel | What it shows | Infra |
|---|---|---|---|
| 40 | Weather | Current conditions, radar loop, 7-day crawl, smooth jazz bed | weather tool |
| 41 | Net Health | Speedtest history, latency, per-device status, outage log | `speedtest.ts`, `connectivity.ts`, `adminConnectivity.ts` |
| 42 | NOC | Homelab wall: server/GPU/disk/monitoring dashboards | `monitoring.ts`, `adminGpu.ts`, `adminServer.ts` |
| 43 | Family Map | Who's where: family locations on the map globe | `maps.ts`, iCloud Find My (`lib/icloud/`) |
| 44 | Calendar | Family calendar: today/this week, whose-event color coding | iCloud calendar |
| 45 | Countdown | Birthdays, holidays, vacation countdowns with hype cards | `holidays.ts`, calendar |
| 46 | Sports Ticker | Scores and schedules for followed teams | `sportsToday.ts`, `sports.ts` |
| 47 | Night Sky | What's overhead tonight: moon phase, planets, ISS passes | moon phase app, `SpaceBackdrop` |
| 48 | Arrivals | Package tracking as an airport arrivals board | new integration (gap) |
| 49 | Commute | Live drive times to school/work, morning daypart only | maps + traffic provider (gap) |
| 50 | Energy | Power usage, solar, cost today | `homeAssistant.ts` |
| 1 | Guide | The Prevue channel: scrolling EPG over music, THE nostalgic centerpiece | reads `tv_schedule` |

### AI-produced channels (block kind: segment, pre-rendered)

| # | Channel | What it shows | Infra |
|---|---|---|---|
| 60 | Local News | AI anchor reading local headlines over article imagery, lower-third crawl | `lib/briefing/localNews.ts`, TTS, ComfyUI |
| 61 | Family Tonight | Nightly household newscast: tomorrow's calendar, photos of the day, packages, chore shout-outs | calendar, photos, briefing engine |
| 62 | Story Time | AI bedtime stories (optionally starring the kids), illustrated, bedtime daypart | `booksGenerate.ts` pipeline, TTS, ComfyUI |
| 63 | Quiz TV | AI trivia game show with countdown timers, family-specific rounds | LLM + `page` hybrid |
| 64 | Rabbit Hole | Documentary-style AI deep dives on random encyclopedia topics | kiwix/`zimSearch.ts`, TTS |

### Cross-channel mechanics (features, not channels)

- **AI commercials**: generated ads for household life ("Are YOU tired of shoes in the
  hallway?"), promos for upcoming programs, kid-business "sponsors". Rendered into the
  shared ad pool by the segment pipeline; this turns filler into the best part.
- **Emergency broadcast interrupts**: doorbell/camera/HA alerts cut in EAS-style. Path A:
  SSE-driven overlay (reuse the notification system). Path B: session supervisor splices
  an alert card. Alert text is shown verbatim, never AI-rewritten (house rule).
- **Nightly sign-off**: anthem, test pattern, "MaiPai TV has concluded its broadcast day"
  on kids' channels at bedtime; the schedule itself enforces wind-down.
- **Channel idents/bumpers**: short branded stingers between programs, generated once per
  channel by the segment pipeline.

## Frontend

- New `/tv` app (registry entry in `appCategories.ts`), dark-shell recipe like
  `MusicLayout.tsx` (full-bleed, `data-theme="dark"`, route added to `isFullBleed`).
- Player surface: full-bleed current program, remote-style controls (channel up/down,
  last channel, number entry), transient info banner (channel number/name, program title,
  progress, what's next) on channel change.
- Guide: EPG grid overlay (channels x time), sourced from `tv_schedule`; the Prevue
  channel (channel 1) is a `page` block reusing the same data.
- Admin: MaiPai TV settings page (`AppSettingsShell`): channel manager (create/reorder/
  enable, per-channel config forms per kind), transcode/session limits, segment job
  monitor, ad pool review.
- Kids/profile gating: channels carry an audience rating; kid profiles get a filtered
  dial; family audio time budgets apply.
- Pods/kiosk: a display mode route so a wall-mounted pod or the desktop HUD can be
  "a TV tuned to channel 42".

## Phasing

**Phase 0, the engine and the illusion (M):** schema + scheduler job + `GET
/api/tv/:channel/now` + `/tv` player (Path A only) + guide overlay + three channels that
prove each renderer family: Marathon (media), MaiPai FM (audio), Weather (page). Filler =
static bumper cards.

**Phase 1, the media dial (M):** Movies, Shuffle TV, Creators, Music Video, Podcast
Network, Memories, Public Access; dayparting; join-in-progress polish; watch state.

**Phase 2, live + dashboards (M):** Frigate channels, Security Desk, Fireside, The
Window; NOC, Net Health, Family Map, Calendar, Sports, Countdown; the Prevue Guide
channel; in-app EAS interrupts.

**Phase 3, the AI network (L):** segment production pipeline (jobs, EDL compositing,
asset lifecycle), Local News, Family Tonight, AI commercials, channel idents, sign-off,
Story Time.

**Phase 4, real streams (L):** ChannelStreamSession + HLS engine, Chromium capture for
page/audio channels, cast integration, M3U + XMLTV, Path B EAS splicing. Stretch:
HDHomeRun emulation for Plex Live TV.

**Phase 5, long tail (S each):** Quiz TV, Rabbit Hole, Night Sky, Space, Energy,
Arrivals + Commute (need new integrations), Pet Cam commentary.

## Implementation status (2026-07-24)

Built in the first pass:
- Schema (`tv_channels`, `tv_schedule`, `tv_segments`) in schema.ts + inline runMigrations.
- `backend/src/lib/tv/`: catalog (30 builtin channels + dynamic Frigate camera channels),
  seeded deterministic scheduler with dayparts/filler/signoff, content pools (Plex movies
  and episodes via plexGet listings, YouTube feed + InnerTube search, podcasts, live
  radio, Frigate), SVG logo generator with vips PNG rasterization for guide clients.
- `backend/src/routes/tv.ts`: channels/now/guide/logo/segments + admin CRUD/rebuild +
  IPTV surface (token-gated M3U playlist, XMLTV guide, PNG logos, continuous MPEG-TS
  streams via per-viewer chained-ffmpeg sessions, capped at 3).
- Frontend `/channels` app (label "MaiPai TV", registry id `maipaitv`): dark-shell layout,
  channel dial home page, full player with media/live/audio/page/segment renderers,
  info banner, guide overlay, channel zapping (arrows, digits, buttons), audio-focus
  integration via mediaCoordinator source 'tv', and 15 page-channel screens.

Still open (matches the phasing above): AI segment production pipeline (tv_segments is
plumbed end to end but nothing renders segments yet), AI commercials/idents in the filler
pool, EAS interrupts, HDHomeRun emulation for native Plex tuners (use Threadfin/xTeVe in
front of the M3U+XMLTV for Plex today), Chromium capture so page channels become real
video in the IPTV path (they stream SMPTE bars there for now), per-profile kid gating of
the dial, and an admin settings UI (admin API endpoints exist).

## Risks and open questions

1. **Encoder vs AI resource contention.** ffmpeg/Chromium capture competes with
   LLM/image loads on the same box. Mitigate via `resourceMode.ts` integration, session
   caps, and the Path A-first design (most viewing never transcodes).
2. **YouTube fragility.** yt-dlp resolution breaks periodically; Creators/Music Video
   channels need graceful skip-to-next-block behavior, and the existing cache-then-serve
   pattern (`videoStream.ts`) should front YouTube blocks.
3. **Plex auth and transcode decisions.** Direct-play vs Plex-transcoded sources on
   tune-in with an offset needs care in `lib/plex/resolve.ts` usage.
4. **Location privacy.** Family Map must respect the consent system (`consent.ts`) and
   probably default to household-members-only visibility with per-user opt-in.
5. **AI segment cost/failure.** Nightly generation can fail or fall behind; the
   scheduler's "only air ready segments, else filler" rule is the safety net, but the
   admin job monitor needs clear failed-segment surfacing.
6. **Chromium capture performance** for 1080p30 page channels is unproven on the target
   hardware; validate early in Phase 4 (Path A is unaffected).
7. **Sync tightness.** Path A clients within a couple seconds of each other is fine for
   the illusion; do not chase frame-accurate sync (watch-together already exists for
   that: `watchTogether.ts`).
