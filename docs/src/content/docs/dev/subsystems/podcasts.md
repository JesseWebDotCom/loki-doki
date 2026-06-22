---
title: Podcasts
description: "AI podcast generation: shows/episodes/suggestions, the adapter to script to TTS to MP3 pipeline, stingers, and the YouTube reverse link."
sidebar:
  order: 7
---

import { Aside } from '@astrojs/starlight/components';

AI-hosted podcast shows generated entirely on-device: content adapters collect source material, an LLM writes a multi-host script, the voice server (Kokoro) speaks each line, and the turns are spliced into an MP3 with intro/outro music, a cover, and chapters. Generation runs in the durable download queue, never on the request path.

Key files:

- `backend/src/routes/podcasts.ts`: shows/episodes/suggestions CRUD, streaming, the cover/stinger/soundfont endpoints. Mounts at `/api/podcasts`, all `requireAuth`.
- `backend/src/lib/podcast/generate.ts`: `runPodcastGenerateJob`, the full pipeline (called from `downloadJobs.ts` for `type: 'podcast-generate'`).
- `backend/src/lib/podcast/adapters/index.ts`: `runAdapter` and the per-source adapters.
- `backend/src/lib/podcast/script.ts`: `generateScript` (LLM).
- `backend/src/lib/podcast/persona.ts`: cast personas and per-episode "beats".
- `backend/src/lib/podcast/episodeMeta.ts`: AI title + show notes.
- `backend/src/lib/podcast/audio.ts`: TTS → WAV assembly → ffmpeg MP3.
- `frontend/src/pages/podcast/`: `PodcastBrowsePage`, `PodcastLibraryPage`, `ShowDetailPage`, `ListenNowPage`.

Tables: `podcast_shows`, `podcast_episodes`, `podcast_episode_sources`, `podcast_suggestions`, `podcast_watch_state`.

## Data Model

A **show** (`podcast_shows`) carries `style`, `hostsJson` (`{ characterId, role }[]`), `segmentsJson` (the content sources), `visibility` (`personal` | `shared`), `coverRelPath`, `stingerJson`, `castJson`, and `sourceRef` (origin tag, e.g. `channel:<id>`). An **episode** (`podcast_episodes`) goes `pending → generating → ready` (or `failed`) and stores `audioRelPath`, `durationSec`, `chaptersJson`, `scriptJson`, plus the AI `title`/`description`.

Access control (`canSeeShow` / `canEditShow`): a user may **view** a show they own, a `shared` show, or any show if admin; only the owner or an admin may **mutate**. Episode routes resolve the parent show rather than trusting a bare episode id.

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/shows` | Visible shows (own + shared), hosts/segments resolved. |
| `GET` | `/feed` | All visible shows **and** their episodes in a few queries (avoids an N+1 per-show waterfall). |
| `GET` | `/by-video/:videoId` | Reverse link: ready episodes generated from a YouTube video, visible to the caller. Powers the watch-page "Featured in podcasts" shelf. |
| `POST/PUT/DELETE` | `/shows[/:id]` | Show CRUD (DELETE gathers on-disk artifacts before cascading). |
| `POST` | `/describe` | LLM-written show blurb (client falls back to a local template). |
| `PUT/GET` | `/shows/:id/cover` | Cover PNG store/serve. |
| `GET` | `/soundfont` | Serves the shared SoundFont; downloads it lazily on first request. |
| `PUT/GET` | `/shows/:id/stinger[/:part]` | Store/serve a show's intro+outro stinger WAVs (24 kHz mono). |
| `GET` | `/episodes/:id` | Episode detail incl. transcript (host ids → names). |
| `GET` | `/shows/:id/episodes` | A show's episodes. |
| `POST` | `/shows/:id/generate` | Enqueue a `podcast-generate` job for a new episode. |
| `POST` | `/episodes/:id/regenerate` | Clear the audio and re-queue. |
| `DELETE` | `/episodes/:id` | Delete (and unlink the audio). |
| `GET` | `/episodes/:id/stream` | Range-aware MP3 streaming (`audio/mpeg`). |
| `POST` | `/watch-state` | Upsert resume position/`completed`. |
| `GET` | `/suggestions`, `POST .../accept`, `.../dismiss` | Seeded suggestion templates → new shows. |

`/suggestions` seeds `SUGGESTION_TEMPLATES` (YouTube Daily Recap, YouTube In-Depth, Morning Briefing, Sports Roundtable) per user on first load.

## Generation Pipeline (`runPodcastGenerateJob`)

Runs inside the download queue (`domain: 'podcast'`, `sizeClass: 'small'`). The episode row flips to `generating`, then:

```
load show → run content adapters (parallel)
  → load host characters + build/advance cast personas & "beats"
  → generateScript (LLM)            → ScriptTurn[]  ({ host, text })
  → generateEpisodeMeta (LLM)       → title + show notes
  → build HostVoiceMap from each host's ttsVoice/speechRate
  → buildEpisodeAudio (TTS → WAV → MP3, with stingers + cover + chapters)
  → persist audioRelPath/duration/chapters/script + episode_sources
```

A per-episode `segments` override in the job payload (used by the YouTube bridge) takes precedence over the show's configured segments.

### Content adapters

`runAdapter(segment, userId, userFirstName)` dispatches on `segment.type`: `youtube`, `news`, `sports`, `onThisDay`, `weather`, `custom`. Each returns `SegmentContent` including a `sources` array; the `youtube` adapter tags sources `{ type: 'youtube', id: videoId, title }`, which is what feeds `podcast_episode_sources`.

### Script

`generateScript` (`script.ts`) drives the chat model with a per-style guide and an explicit `targetWords` (LLMs hit a word count more reliably than a "minutes" hint). It runs at `num_ctx` 8192 (`SCRIPT_NUM_CTX`) because a long transcript otherwise fills the default 2048 context and leaves no room to generate. Personas/beats from `persona.ts` are woven in so hosts carry continuity; a host can be marked `away` and dropped from the script (never to the point of emptying the room).

### Audio (`audio.ts`)

<Aside type="note">
The voice server (kokoro-js) emits 24 kHz mono **IEEE float (32-bit)** WAVs, but the episode is assembled as **16-bit PCM**. `extractPcmFromWav` converts float32 → int16; skipping this yields noise at the wrong speed. The whole pipeline is 24000 Hz / mono / 16-bit.
</Aside>

Each turn's text is segmented into sentences (`segmentSentences`), cleaned for speech (`stripForSpeech`), and synthesized through the voice server at the host's voice and a speed floored at `MIN_SPEED` (1.2). Turns are joined with `BETWEEN_TURN_SILENCE_SEC` (0.18s) gaps and grouped into chapters. Stinger clips (if present) are faded and spliced at the head/tail. The assembled WAV is converted to MP3 with `ensureFfmpeg()` (`libmp3lame -q:a 2`), embedding the title/show as metadata and the cover art, then the temp WAV is dropped.

## Stingers and the Music Engine

The intro/outro music is **not** generated on the backend. It is rendered client-side by the shared offline music engine (`frontend/src/lib/music/engine.ts`, see the [Music](/dev/subsystems/music/) subsystem) and uploaded as 24 kHz mono WAVs to `PUT /shows/:id/stinger`. The backend only stores those WAVs (`stingerJson`) and splices them during assembly.

`GET /soundfont` serves the shared GeneralUser-GS SoundFont (`ensureStingerSoundfont` in `backend/src/lib/download.ts`), downloaded lazily on first request and recorded so boot reconcile keeps it repaired. The client's `getSoundBank()` fetches it from there.

## YouTube Reverse Link

`podcast_episode_sources` rows are written both at queue time (by `POST /api/youtube/podcast`, so a "next batch" can skip already-processed videos) and again after generation in `generate.ts` (`onConflictDoNothing`). `GET /by-video/:videoId` joins these to ready episodes and filters to the caller's visibility, surfacing the watch-page shelf.

## Regression Notes

| Symptom | Likely cause |
|---|---|
| Episode audio is noise / wrong speed | `extractPcmFromWav` float32→int16 path bypassed. |
| Episodes come out tiny | `SCRIPT_NUM_CTX` lowered, or `targetWords` removed. |
| Generation stuck at `pending` | The `podcast-generate` job isn't being picked up by the download queue. |
| No stinger on episodes | Show has no `stingerJson`, or the client never uploaded the rendered WAVs. |
| Soundfont 503 | `ensureStingerSoundfont` couldn't download GeneralUser-GS. |
