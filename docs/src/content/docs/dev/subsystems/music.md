---
title: Music
description: "The offline music engine: tonal composition rendered to MIDI and a pure-JS SoundFont synth, shared by the Music app and podcast stingers."
sidebar:
  order: 8
---

import { Aside } from '@astrojs/starlight/components';

A fully-offline, client-side music generator. Composition is pure music theory (`tonal`), arranged to multi-track MIDI (`@tonejs/midi`), and rendered by a pure-JS SoundFont synth (`spessasynth_core`) at 24 kHz mono. No native binaries, no per-OS assets, no model download. The same engine powers both the Music app and the podcast intro/outro stingers.

Key files:

- `frontend/src/lib/music/engine.ts`: the shared engine (`resolveStyle`, `arrange`, `renderMidiToWav`, `getSoundBank`, `encodeMonoWav`, styles, grooves).
- `frontend/src/lib/music/remix.ts`: MIDI import + restyle.
- `frontend/src/lib/music/engines/`: the engine-registry seam (`midiOffline.ts`, future neural/server engines slot in here).
- `frontend/src/lib/music/api.ts`: `saveTrack`/`listTracks`/`renameTrack`/`deleteTrack`/`trackAudioUrl` (the backend client).
- `frontend/src/pages/MusicPage.tsx`: the Generate / Remix / Library tabs.
- `backend/src/routes/music.ts`: per-user track storage + serving (`/api/music`, `requireAuth`).
- `backend/src/lib/download.ts`: `ensureStingerSoundfont` (the SoundFont fetch), served via `GET /api/podcasts/soundfont`.

<Aside type="note">
v1 generation is **entirely client-side**: the browser renders a WAV and the backend only stores the finished blob. `backend/src/routes/music.ts` is shaped so a future server-side engine slots in additively (a `POST /tracks/generate` writing into the same row via the `state` lifecycle, and `POST /tracks/:id/stems` for child `kind='stem'` rows).
</Aside>

## The Engine

`engine.ts` was extracted from the old `podcast/stinger.ts` so the stinger picker and the Music app share one engine. It works in three stages.

### 1. Style → arrangement (`resolveStyle`)

`MUSIC_STYLES` is a list of style *pools* (`Warm`, `Newsy`, `Upbeat`, `Lo-fi`, `Cinematic`, `Tech`, `Synthwave`, `Funk`, `Ambient`, `Playful`, `Corporate`, `Hip-hop`). Each carries a BPM range, a key pool, a mode (`major`/`minor`/`dorian`), chord progressions (Roman numerals), GM instrument alternatives per role, and a groove family.

`resolveStyle(style, seed, overrides)` uses a seeded PRNG (`mulberry32`) to draw one concrete arrangement: BPM, key, a progression (the style's own plus a shared mode pool, via `Progression.fromRomanNumerals`), instruments, and procedurally-generated drums (`genDrums`) and bassline (`genBass`) within the groove family. The seed makes a take deterministic, so intro+outro stingers for the same show match. `ResolveOverrides` (`bpm`, `keyName`) pin choices for the Generate UI without shifting later RNG draws.

### 2. Arrangement → MIDI (`arrange`)

`arrange(R, { structure, bars, layers })` builds layered, humanized MIDI (`@tonejs/midi`). `Structure` is `intro | outro | loop | full`:

- `intro` (default 2 bars) builds over its bars; `outro` (1 bar) is a short tag resolving to the tonic. Both reproduce the original podcast stinger behavior exactly.
- `loop` (4 bars) tiles the progression to cycle seamlessly; `full` (8 bars) builds in and rings out.

Tracks: pad, bass, lead (a diatonic walk with varied rhythm cells), optional keys, and drums on channel 9. Notes get ±6ms timing and velocity jitter; per-track reverb/chorus/volume CCs make it sound produced. Layers can be muted individually.

### 3. MIDI → WAV (`renderMidiToWav`)

`getSoundBank()` fetches `/api/podcasts/soundfont` once and parses it with `SoundBankLoader` (cached for the session). `renderMidiToWav(smf, fadeOutSec)` runs `BasicMIDI` + `SpessaSynthProcessor` + `SpessaSynthSequencer` offline, pulling samples in 128-frame blocks, downmixes to mono with fade in/out, then `encodeMonoWav` peak-normalizes to ~0.85 FS.

<Aside type="caution">
`encodeMonoWav` calls `audioToWav(..., { normalizeAudio: false })` deliberately. With normalization on, `audioToWav` rescales the loudest sample to full scale, erasing the headroom and making a hot multi-layer mix sit louder than speech in a spliced podcast. Keep it off.
</Aside>

Output is always **24 kHz / mono / 16-bit** (`MUSIC_SAMPLE_RATE = 24000`), matching the podcast audio pipeline so stingers splice cleanly.

## Remix (`remix.ts`)

Imports a `.mid`, classifies its pitched tracks by register (lowest = bass, highest = melody, rest = chords), keeps each part's actual notes/timing/velocity/key/tempo, re-points them to the chosen style's instruments, and adds the style's drum groove. The composer's notes are preserved; only the sounds and the beat change. The style never imposes its own notes or key.

## MusicPage (Generate / Remix / Library)

- **Generate** renders six takes per style/structure (`hashStr(...)` seeds, so Regenerate yields different on-brand arrangements), then `saveTrack(blob, { kind, engine: 'midi-offline', ... })`.
- **Remix** parses a MIDI file, renders restyled variants, saves with `engine: 'remix'`.
- **Library** lists/plays/renames/deletes saved tracks. Stems are excluded from the listing.

`TRACK_TYPES` maps the UI's track kinds to engine structures: Full track → `full` (8 bars, editable), Loop/bed → `loop` (4, editable), Intro → `intro` (2, fixed), Outro → `outro` (1, fixed).

## Storage (`backend/src/routes/music.ts`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/tracks` | Multipart `audio` WAV + metadata → stores `music/<id>/main.wav`, inserts a `music_tracks` row (`state: 'ready'`). |
| `GET` | `/tracks` | The caller's tracks, newest first (stems excluded; optional `kind`/`engine` filters). |
| `GET` | `/tracks/:id/audio` | Range-aware `audio/wav` serving. |
| `PATCH` | `/tracks/:id` | Rename. |
| `DELETE` | `/tracks/:id` | Delete row + per-track directory. |

The `music_tracks` table (`backend/src/db/schema.ts`) carries `kind` (`track`/`intro`/`outro`/`loop`/`bed`/`stem`), `engine` (`midi-offline`/`neural`/`remix`/`upload`), `styleId`, `bpm`, `keyName`, `sourceName`, `prompt`, `metaJson`, `durationSec`, the `state` lifecycle (`building`/`ready`/`failed`/`cancelled`), `parentTrackId` (stem self-ref), `path`, and `isAdult` (default `false`).

<Aside type="note">
`isAdult` exists on `music_tracks` (the shared privacy/adult-content flag, same as `loras` and `generated_images`), but the v1 client-rendered insert path never sets it, so saved tracks are non-adult by default. It is wired for a future content-aware generation path.
</Aside>

## The SoundFont

`ensureStingerSoundfont` (`backend/src/lib/download.ts`) downloads GeneralUser-GS (`GeneralUser-GS.sf2`, permissively licensed) to `audio/soundfonts/` on first request and records it for boot reconcile. It is served by `GET /api/podcasts/soundfont` (shared with podcasts) and cached aggressively. This single ~30 MB fetch is the only network dependency; after it, generation is fully offline.

## Regression Notes

| Symptom | Likely cause |
|---|---|
| "Couldn't prepare the music engine" | `/api/podcasts/soundfont` failed (`ensureStingerSoundfont` couldn't download GeneralUser-GS). |
| Music louder than speech in podcasts | `normalizeAudio: false` flipped on in `encodeMonoWav`. |
| Intro and outro stingers don't match | Seed not shared between the two `arrange` calls for a show. |
| Remix sounds wrong / invented notes | Restyle should reuse the file's own notes; only instruments + groove change. |
| Stingers won't splice into an episode | Output not 24 kHz mono 16-bit. |
