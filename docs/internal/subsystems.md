# Subsystem Reference

## Character System

Characters are virtual companions: animated avatars with a name, personality, and voice. They are not just prompt personas; each user builds a unique relationship with each character over time.

**The user has an existing character and animation system. We integrate with it; we do not build the animation layer.**

### How characters work

- Characters are defined globally by the admin (name, personality, voice, avatar reference)
- Any user can start a relationship with any character
- When user A and user B both use character "Alex", each gets their own instance: same personality, separate memories, separate relationship history
- The character speaks and responds entirely in-character at all times

### Database schema

```
characters
  id, name, slug,
  personality_prompt,    ← the character's system prompt / persona definition
  backstory,             ← longer narrative context injected for deep questions
  voice_id,              ← references voice_samples.id for XTTS
  avatar_ref,            ← ID/ref passed to the external animation system
  created_by,            ← admin user id
  is_active,
  created_at, updated_at

voice_samples
  id, character_id,
  file_path,             ← path under data/voices/<character_id>/
  duration_seconds,      ← must be 30+ for good cloning
  is_active,             ← only one active sample per character
  created_at

user_characters          ← the "friendship", created on first interaction
  id, user_id, character_id,
  nickname,              ← optional override for what the character calls the user
  created_at             ← when this relationship started
```

### Response generation with a character

```
1. Build system prompt:
     character.personality_prompt
     + character.backstory (capped ~700 chars; injected since 2026-08 — "draw on
       this when your past comes up, never recite")
     + relevant character-global memories (the character's OWN opinions/worldview
       — written by the self-judge since 2026-08)
     + relevant user-character memories (what this character knows about this user,
       incl. promises it made to them)
     + user-global memories (facts about the user any character can access)
     + recent conversation history (working memory)
     + a compressed in-character reminder near the END of the prompt (anti-drift:
       persona attention decays with distance; see companionTurn buildSystemParts)

2. Route the prompt (semantic router → tools if needed)

3. LLM generates response in character

4. Stream text response to frontend

5. Send text to XTTS → stream audio in character's voice

6. Frontend plays audio + drives animation system
```

---

## Voice Subsystem (TTS + Wakeword + Hands-free)

Ported from v2's proven voice stack. The non-negotiable: **stream input/output as fast as it arrives**, sentence-chunked, never batch the whole reply.

### One Bun voice-server sidecar (no Python, no prebuilt binaries)
`backend/scripts/voice-server.ts` runs **Kokoro-82M TTS** (`kokoro-js`) + **Whisper base.en STT** (`@huggingface/transformers`) on onnxruntime-wasm. Models auto-download from HF into `data/voice/models/` on first load. Managed by `lib/voiceServer.ts` (kiwix pattern: `maybeSpawnVoiceServer` from `index.ts`, `/health` poll, `isVoiceServerInstalled` = Kokoro model present). Endpoints: `POST /synthesize {text,voice,speed}→wav`, `POST /inference (wav)→{text}`, `GET /voices`, `GET /health`. URL: `voice.server_url` → `VOICE_SERVER_URL` → `:8091`.

Wakeword: **OpenWakeWord** ONNX in-browser (`onnxruntime-web`, WASM in `frontend/public/ort/`); detector models downloaded at runtime to `data/voice/wakewords/`, served at `/api/voice/wakeword/*`. Do **not** use Qwen3-TTS (Alibaba/Chinese-origin → banned). Cloning (F5/XTTS) deferred.

### Install wiring (components, not catalog models)
- Features (`frontend/src/lib/features.ts`): Voice group → base `voice-core` + item `wakeword-core` (both `type:'component'`).
- `adminInstall.ts` `/repair` dispatch: `voice-core` → `installVoiceModels` (warms Kokoro+Whisper via `bun scripts/voice-server.ts warm`), `wakeword-core` → `downloadWakewordCore` (mel+embedding+hey_jarvis). GET `/` reports installed status. `system.ts` boot adds a `voice` step (spawn if installed; no heavy auto-download).
- Wakeword browser: `routes/adminWakewords.ts` (curated OpenWakeWord catalog → SSE `/import` → `data/voice/wakewords/` + `wake_word_catalog` row → DownloadProgress). Admin-only (voices/wakewords are a character property, no per-user grants).

### Custom wakeword training (`lib/voice/wakewordTrainer.ts` + `scripts/train_wakeword.py`)
Train a per-character detector from a phrase, no recordings. SSE `POST /api/admin/wakewords/train {phrase,label,characterId}`. The recipe matters; earlier naive versions fired on noise/"hey alexa":
- **Positives**: Kokoro TTS of the phrase across **all available voices** (gender/accent-balanced via `pickDiverseVoices`), few speeds. Real-mic robustness comes from augmentation, not raw count.
- **Augmentation** (Python, procedural, no datasets): each clip → reverb (synthetic RIR) + noise-mix at random SNR + gain jitter, ~12 variants. This is the single biggest factor for generalizing synthetic TTS → real mic.
- **Negatives**: generic phrases + **contrastive "hey alexa/google/siri" in the SAME voices as positives** (teaches the *word*, not a voice cue) + procedural silence/noise clips + **openWakeWord's precomputed real-world negative feature bank** (`negative_features.npy`, 180 MB, `(481345,96)` float32, downloaded once via `downloadNegFeatures`; sample ~40k 16-frame windows). The large diverse negative set is what makes "hey alexa" score ~0 vs "hey loki" ~0.9.
- **Model**: silence-aware window labeling → StandardScaler → small **MLP** (32 hidden, `sklearn`) → ONNX (`Reshape→Gemm→Relu→Gemm→Sigmoid`, `x.1[1,16,96]→[1,1]`, ~197 KB). Threshold auto-calibrated on a held-out split, stored as `wake_word_catalog.defaultThreshold`. Training attaches the model to the character server-side (sets `characters.wakeWordModelId`, clears any phrase).
- **Tester**: `WakewordTester` in `voiceControls.tsx` opens from a per-character **Test** button (modal in `AdminCharactersTab`). Live mic level + score vs threshold; each detection is transcribed via `POST /api/voice/transcribe` (shows the words heard); **Save** persists a tuned threshold (`PATCH /api/admin/wakewords/:id`); Copy exports the log.
- **Single wakeword source invariant**: a character uses *either* a trained `wakeWordModelId` *or* a `wakeWordPhrase` (Whisper ASR via `whisper-wakeword-loop.ts`), never both: the model wins (`useHandsFree.ts`), and `adminCharacters.ts` clears the phrase when a model is set. Empty phrase never matches (`includes("")` guard). STT drops Whisper non-speech annotations (`[BLANK_AUDIO]`, `(typing)`) via `isLikelySpeech` in `sttSession.ts` so typing/noise can't become a turn.

### TTS engine registry: `backend/src/lib/voice/`
- `engineRegistry.ts` parses qualified `engine:voice_id` (`kokoro:af_heart`; bare → kokoro). `getTtsEngine` → `engines/kokoroEngine.ts` (POST `/synthesize` → WAV → int16 PCM via `pcm.ts`).
- `voiceResolver.ts`: character (`characters.ttsVoice`) → user → app default (`voice.app_default_voice`, e.g. `kokoro:af_heart`). Same chain for wakeword (`characters.wakeWordModelId` → `voice.app_default_wakeword`).
- `sentenceSegmenter.ts`: hand-rolled (no pysbd), `.?!` split, clause fallback >160 chars.
- Admin UI: `components/admin/voiceControls.tsx`: `VoicePicker` (Kokoro voices from `/api/admin/voice/voices` + preview), `WakewordSelect` (installed), `WakewordBrowser` (download catalog).

### Routes
- `POST /api/tts/stream`: NDJSON, one `SentencePayload` per synthesized sentence, ends `{done:true}`. `GET /api/tts/status` probes engine health.
- `WS /api/stt/stream`: browser ships `hello` + f32le PCM frames; `SttSession` (`lib/voice/sttSession.ts`) runs RMS-VAD endpointing → whisper.cpp → `partial`/`final`/`vad`/`no_speech`. **Bun WS requires `websocket` on the default export in `index.ts`** (load-bearing).
- `POST/GET/PATCH/DELETE /api/admin/voice/...`: voice-sample CRUD + app-default settings.

### Frontend: `frontend/src/lib/voice/` + hooks
- Playback: `tts-playback-scheduler.ts` (one AudioContext, queued sources, `max(now+50ms, nextStart)`) + `voice-playback.ts` (2 parallel synth fetches, ordered enqueue) + `voicePlaybackStore.ts` (singleton + hooks).
- Lip-sync: `tts-character-bridge.ts` drives audio-clock visemes/captions → `RiggedDicebearAvatar` `audioViseme` prop (cadence flap is the TTS-off fallback). `useCompanionVoice` feeds completed sentences to TTS.
- Hands-free: `useHandsFree.ts` + `handsfree-state-machine.ts`: wake (`wake-word-loop.ts`, OpenWakeWord) → STT (`stt-capture.ts`) → `ChatContext.submit` → reply spoken → TTS-end → post-reply re-listen. 400ms echo-guard mutes the mic during playback. Toggles: `companion.voiceOn` / `companion.handsFreeOn` (both default off).

---

## Memory System

Every character-user relationship has its own memory. Memories are extracted automatically from conversations; the user never has to explicitly save anything.

### Memory scopes

| Scope | user_id | character_id | What it holds |
|---|---|---|---|
| User-global | ✓ | `null` | Facts about the user, accessible by any character |
| Character-instance | ✓ | ✓ | What THIS character knows about THIS user |
| Character-global | `null` | ✓ | The character's own knowledge and worldview |

### Memory categories

| Category | Example inference |
|---|---|
| `person` | "my wife Sarah" → person named Sarah, relationship: wife |
| `place` | "I live in Austin" → location: Austin |
| `thing` | "forgot to charge my car" → user has electric car |
| `preference` | "I hate cilantro" → dislikes cilantro |
| `identity` | "I'm a software engineer" → occupation |
| `event` | "I ran a 5k last Saturday" → past event |
| `project` | "I'm building a home theater" → ongoing project |
| `goal` | "I want to visit Japan" → aspiration |
| `relationship` | "my son Jake is 8" → has son Jake, age 8 |
| `fact` | general facts that don't fit above |

### Database schema

```
conversations
  id, user_id, character_id, title, pinned,
  memory_processed_through,   ← timestamp: how far the judge has processed; null = never
  created_at, updated_at

messages
  id, conversation_id, role (user|assistant|system), content, created_at

entities                       ← named people/places/things personally relevant to the user
  id, user_id, character_id (nullable),
  name,           ← canonical name: "Artie"
  kind,           ← person | place | thing | org
  aliases,        ← TEXT JSON array of lowercase variants: ["artie","brother","art"]
  importance,     ← 1–10
  last_seen_at,   ← updated when entity is mentioned in recall
  created_at, updated_at

memories
  id, user_id, character_id (nullable),
  entity_id,         ← FK to entities (nullable), links fact to its named subject
  text,              ← the extracted fact: "user has an electric car"
  source_text,       ← original quote: "I forgot to charge my car today"
  category,          ← see categories above
  tier,              ← durable | episodic (see Tiers below)
  status,            ← active | superseded | archived (soft-delete, never hard-delete)
  embedding,         ← TEXT (JSON float array from nomic-embed-text)
  importance,        ← 1–10 (identity/relationship = 9–10)
  pinned,            ← always injected (core identity/relationship facts)
  uses,              ← times retrieved, incremented on every recall
  last_used_at,      ← timestamp of last recall; drives decay scoring
  created_at, updated_at

memory_episodes
  id, user_id, character_id,
  conversation_id,
  summary,           ← LLM-generated summary of the conversation
  embedding,         ← TEXT (JSON float array)
  message_count,
  created_at
```

### Memory tiers

| Tier | Categories | Policy |
|---|---|---|
| `durable` | identity, relationship, person, preference | Never pruned, no recency decay |
| `episodic` | event, project, goal, thing, place, fact | Subject to decay & archival |

### Out-of-band extraction (the "sleep-time" judge)

Memory extraction runs **out-of-band**: the request path is never slowed down.

The background sweep (`memory/sweep.ts`) checks every 5 minutes for conversations where:
- The user has been idle for ≥ 5 minutes (last message > 5 min ago), AND
- There are messages newer than `memory_processed_through` (unprocessed content).

For each such conversation, the **judge** (`memory/judge.ts`) processes the full unprocessed span:

```
1. Judge sees the ENTIRE unprocessed conversation span (not just 6 messages).
   This is the core fix: it can tell a one-off curiosity from a real preference.

   DISCARD: questions, trivia lookups, temporary moods, one-off tasks
   PERSIST: stable identity, relationships, preferences, projects, goals

   Examples:
     "How long does meat spoil on the counter?" → DISCARD
     "My brother Artie loves horror movies"     → entity: Artie, fact: "Artie loves horror movies"
     "I'm so tired today"                       → DISCARD (temporary state)
     "I've been vegetarian for 10 years"        → PERSIST (identity, durable)

2. Entity extraction: named people/places/things → upserted into `entities` table with aliases.

3. Fact extraction + dedup (mem0 ADD/UPDATE/DELETE/NO_CHANGE pattern):
   a. Extract candidate facts from the conversation
   b. Embed each; find existing memories with cosine > 0.5
   c. LLM decides: ADD / UPDATE (merged text) / DELETE (contradicted) / NO_CHANGE
   d. DELETE = soft-delete (status=superseded), never hard-delete (Zep bi-temporal pattern)
   e. Link each fact to its entity_id; assign tier and importance

4. Advance conversations.memory_processed_through cursor.
```

The sweep also generates episode summaries (every 20 messages) and runs maintenance hourly.

**Why out-of-band beats inline:** inline extraction sees only the last 6 messages mid-conversation, so a one-off question ("how long does meat stay fresh?") can become a permanent fact. The judge sees the full session and knows the difference.

### Episodic summary

When a conversation accumulates 20+ messages the sweep generates a summary stored in `memory_episodes`. Summaries are **retrieved semantically** at recall time (cosine search against the current prompt) and included in the injected block under "Past conversations:".

### Retrieval and injection

Entity-first, then vector, two-pass hybrid (v2 wiki pattern):

```
Incoming prompt:
  1. Embed prompt (nomic-embed-text)
  2. Entity pass (deterministic):
       Tokenize prompt → match tokens against entities.name + aliases
       Load ALL active memories linked to matched entities (entityId match)
       Guarantees "would Artie like this?" surfaces Artie's facts after months of silence
  3. Vector pass (semantic):
       Cosine search over remaining non-entity memories across 3 scopes:
         user-global (character_id IS NULL)
         character-instance (character_id = current)
         character-global (user_id IS NULL)
       Score = 0.7 × cosine + 0.2 × importanceNorm + 0.1 × recency
         durable tier: recency = 1 (no decay)
         episodic tier: recency = 1/(1 + ageDays × 0.05)
       Return pinned + top-5 non-pinned above 0.12 threshold
  4. Merge entity + vector results; cap to ~1200 chars prompt budget
  5. Inject block into system prompt:
       "Core facts:" (pinned/durable)
       "People & places:" (entity-linked facts)
       "Remembered context:" (episodic)
       "Past conversations:" (episode summaries)
  6. Background: increment uses + update last_used_at for recalled memory ids
```

### Lifecycle / maintenance

Runs hourly (never blocks requests):

- **Durable tier:** never touched.
- **Episodic tier:** decay score = `0.995^hours_since_last_used × importance/10 × (1+log(uses+1)×0.1)` (Generative Agents formula).
- Archive episodic memories with decay score < 0.10 AND unused for ≥ 30 days.
- Enforce per-scope cap of 200 active episodic memories (archive lowest-scoring beyond cap).
- Retain most recent 250 episodes per (userId, characterId) (raised from 50, 2026-08); delete older ones.
- All archival is logged: no silent truncation.

### 2026-08 additions (companion intelligence audit, Phases 3/5)

- **Companion self-memory** (`memory/judge.ts` `runSelfJudge`, called by the sweep
  for character conversations): a separate small extraction pass stores the
  COMPANION's own opinions (character-global scope: userId null, characterId set),
  and its promises/personal statements to this user (character-instance scope).
  Recall renders them as a dedicated "Your own past statements" section with a
  stay-consistent / follow-through instruction. This finally populates the
  character-global scope the schema defined from day one.
- **Episode recall upgraded** (`memory/recall.ts`): up to 3 episodes injected
  (was 1), ranked by cosine blended with recency, each prefixed with a relative
  date ("yesterday", "2 weeks ago"). Temporal questions ("what did we talk about
  last week?") pull episodes by parsed date range (`parseTemporalRange`)
  regardless of cosine.
- **recall_conversations tool** (`tools/recallConversations.ts`): searches the
  user's raw past transcripts + episode summaries by topic tokens and/or
  timeframe (Claude-memory pattern), with a router fast path for "what did we
  talk about" questions. Strictly scoped to the asking user.
- **Knowledge paragraph** (`memory/profile.ts`, `memory_profiles` table): one
  compact per-user "who this person is" paragraph, regenerated as a sleep-time
  job when the judge writes new facts, injected at the top of every memory block
  (ChatGPT-memory shape — every turn gets a coherent baseline, not a recall
  lottery).
- **Bi-temporal columns** (`memories.valid_from`, `memories.superseded_by`):
  a superseding fact links its predecessor; recently-changed facts render as
  "fact (previously: old fact)" so the companion can acknowledge changes.
- **Weekly consolidation** (`memory/consolidate.ts`): merges near-duplicate
  active facts (cosine ≥ 0.86) and supersedes contradicting durable facts the
  judge's cosine-gated dedup could never meet. Bounded per run, idle-gated,
  app_settings-stamped.
- **Mood state** (`memory/mood.ts`, `user_moods` table): emotionally loaded user
  messages trigger a detached fast-model classification; fresh moods (<20h)
  inject 1-2 lines of tone guidance. Episode summaries also record notable
  emotional tone (one clause) for "last time you seemed stressed" continuity.
- **Prompt budget** is now 2600 chars (`PROMPT_CHAR_BUDGET`) to fit the paragraph
  and self-memory sections. Evals: `eval:memory` (recall gates) and
  `eval:continuity` (multi-turn probes + grep baseline) guard all of this.

**Vector search implementation:** embeddings stored as JSON float arrays in SQLite TEXT column. Cosine similarity computed in-process (JavaScript). At family scale (~10K memories max), linear scan is sub-millisecond: no external vector service needed.

---

## Image Generation API

Routes registered at `/api/image/` and `/api/admin/image-loras/`.

**User-facing (`requireAuth`):**
| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/image/status` | Is ComfyUI running? Returns `{ ok, url }` |
| `GET` | `/api/image/loras` | List LoRAs the current user has access to |
| `POST` | `/api/image/generate` | SSE stream: `start → step* → done/error`. Body: `{ prompt, width, height, steps, guidance, seed, loraIds[], negativePrompt }` |
| `GET` | `/api/image/artifacts/:id` | Serve PNG if ready, JSON state if building |
| `POST` | `/api/image/artifacts/:id/cancel` | Abort in-flight generation |
| `GET` | `/api/image/history` | Recent images for current user |

**SSE event sequence** for `/api/image/generate`:
```
event: start  data: { imageId, steps, width, height }
event: step   data: { step, total, elapsedMs }   ← emitted ~every 1.5s
event: done   data: { imageId }
event: error  data: { message }
```

**Admin-only (`requireAdmin`):**
| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/api/admin/image-loras/` | Full catalog with categoryName, fileExists |
| `POST` | `/api/admin/image-loras/` | Create LoRA entry from staged file |
| `PATCH` | `/api/admin/image-loras/:id` | Edit metadata |
| `DELETE` | `/api/admin/image-loras/:id` | Delete catalog entry (file kept on disk) |
| `GET/POST/PATCH/DELETE` | `/api/admin/image-loras/categories` | Category CRUD |
| `POST` | `/api/admin/image-loras/import-file` | Upload .safetensors → returns `{ filePath, fileName, sizeBytes, suggestedName }` |
| `POST` | `/api/admin/image-loras/civitai-search` | Proxy to Civitai API. Body: `{ query, limit, cursor, nsfw, sort }` |
| `POST` | `/api/admin/image-loras/civitai-import` | SSE: `start → progress* → done/error`. Downloads to `data/loras/`, creates DB entry |
| `GET/PUT` | `/api/admin/image-loras/:id/grants/:userId` | Per-user LoRA grants |
| `GET/PUT` | `/api/admin/image-loras/categories/:id/grants/:userId` | Per-user category grants |

**Permission model (LoRAs):** Default-deny per user. A user accesses a LoRA only if they have an explicit `state='on'` grant (via `image_lora_user_lora_grants` OR `image_lora_user_category_grants`). Admins always have access to all enabled LoRAs. Grant `state` can be `'on'`, `'off'`, or `'none'` (delete the row). The `uncensored_images` key in `user_preferences` controls whether a safety prefix is prepended to prompts.

**Hook:** `useImageGen()` in `src/hooks/useImageGen.ts`, wraps the SSE flow, returns `{ state, generate(params), cancel(imageId), reset() }`.

**LoRA files:** stored in `data/loras/` (ComfyUI's `models/loras` points here). LoRAs are applied via `LoraLoader` nodes in the generated workflow, keyed by filename (without extension).

---

## Maps Subsystem (offline maps, ported from v2)

Offline vector maps with search, routing, and saved pins: same install pattern as the ZIM library / voice / image_gen (heavy tools + data download at runtime, never bundled).

**Frontend**: `frontend/src/pages/maps/` (~65 files) + top-level `pages/MapsPage.tsx`. Renderer: **MapLibre GL 5.23** + **pmtiles** protocol (registered once in `main.tsx`). Offline vector tiles are PMTiles archives served by the backend. Map page is wired at `/maps` (LeftSidebar + App.tsx). Theme via `use-map-theme.ts` (reads `.dark` on `<html>`). Region list via `hooks/useMaps.ts` (`useInstalledMapRegions`, plain fetch, no TanStack). Distance units from `hooks/useAdminSettings.ts`.

**Backend**: `backend/src/lib/maps/` + `routes/maps.ts` (user) + `routes/adminMaps.ts` (admin):
- `catalog.ts`: region catalog (continents → countries/US states), Geofabrik PBF URLs.
- `toolchain.ts`: downloads Temurin JRE 21 + planetiler + GraphHopper + go-pmtiles + font glyphs into `data/maps/tools/`. Component id `maps-toolchain` (in `adminInstall.ts` + `features.ts`).
- `build.ts`: per-region pipeline: PBF → planetiler `streets.pmtiles` → GraphHopper import graph → geocoder FTS5 (`osmium export`, best-effort; skipped if `osmium` not on PATH).
- `geocoder.ts`: FTS5 place search/reverse over per-region `geocoder.sqlite` (bun:sqlite).
- `graphhopper.ts`: spawn-on-demand Java routing sidecar (idle-timeout) + opt-in OSRM online fallback (`LOKIDOKI_ROUTER_ONLINE_FALLBACK=1`).
- `store.ts`: install state in `map_regions` table.

**Routes** (`/api/maps/*`): `geocode`, `geocode/reverse`, `route`, `eta`, `pins` CRUD, `regions`, `catalog`, `tiles/:regionId/streets.pmtiles` (HTTP Range), `glyphs/:fontstack/:range`, `favicon`. Graceful empty: `logos`, `poi-photo`, `incidents`, `collections`, `tiles/_overview/world-*.geojson`. Admin (`/api/admin/maps/*`): `catalog`, `install-toolchain` (SSE), `download/:regionId` (SSE build phases), `cancel`, `reindex`, `storage`, `DELETE`.

**Tables**: `map_regions`, `maps_saved_pins`, `maps_poi_enrichments` (migration `0015_maps.sql` + inline in `db/index.ts`).

**Admin UI**: Admin → **Features** → expand the **Maps** group → `MapsRegionSection` (`src/components/admin/MapsRegionSection.tsx`) lists catalog regions (continent headers + downloadable leaves) with per-region Add/Update/Cancel/Delete and SSE build-phase progress. This mirrors how `ZimSection` renders ZIM "Content Packs" under the Offline Library group: offline data downloads live **inside the feature group**, not as a standalone admin section. The toolchain itself installs via the group's normal base-component (`maps-toolchain`) repair flow. (Note: `AdminArchivesTab.tsx` is legacy/unused; the live ZIM UI is the inline `ZimSection` in `AdminFeaturesTab`.)

---

## Admin Components

### `AdminLorasTab`: `src/components/admin/AdminLorasTab.tsx`

LoRA catalog management tab inside AdminModal. Features:
- Category management (create, grants panel per category)
- LoRA list with filter by category, search by name
- Toggle enabled/disabled per LoRA
- Edit metadata (name, description, category, trigger tokens, weight)
- Per-user access grants (default-deny)
- Import from Civitai (search + SSE download progress)
- Upload .safetensors file directly

Accessed via Admin Panel → LoRAs tab (admin-only).

---

## Listening Together (player presence, remote control, Family Jam)

Software-tier whole-home audio: every app session is a nameable player device other
household members can see, drive, and share a queue with. Pod hardware audio out is out
of scope here.

**Presence** (`backend/src/lib/together/presence.ts`, `frontend/src/hooks/useTogetherPresence.ts`)
- Each session mints a stable device id (localStorage, `lib/together/deviceIdentity.ts`) and
  heartbeats `POST /api/together/presence` with a user-agent label ("Mac / Chrome") and a
  snapshot of its player (source, title, position, playing, volume). 5s while playing, 20s idle.
- The registry is **in-memory** and household-wide: live player state is ephemeral and a stale
  entry ages out (140s). The ONLY durable piece is the user-chosen device name (`player_devices`).
- A session advertises itself only while its command stream is actually up (visible, or
  hidden-but-playing, mirroring `useBrowserSession`'s `keepWhenHidden`). A hidden idle tab drops
  its SSE stream to spare the per-origin connection pool, so listing it would offer a target
  whose commands silently go nowhere.

**Remote control** (`lib/together/commands.ts`, `routes/together.ts`, `components/shared/DevicesPopover.tsx`)
- Commands ride the EXISTING browser-session SSE channel: sessions register their device id at
  connect time (`?device=`), and `pushToDeviceSession()` routes to that one session rather than
  "the user's most recent tab". Same fire-and-verify ack contract as the controller tiles, so an
  undelivered command reports honestly instead of a false success.
- The target executes everything through the player contexts' **public APIs only**
  (`TogetherRemoteReceiver`): transport verbs via the media coordinator (landing on whichever
  engine owns audio), volume per-engine, `play_station`/`play_video` via RadioContext,
  `play_episode`/`queue_episode` via PodcastPlaybackContext. Nothing touches audio elements.
- Surface: a Devices popover in the music mini bar and podcast player bar.

**Family Jam** (`musicJams` / `musicJamItems`, `components/music/JamBanner.tsx` + `JamQueueSheet.tsx`)
- One active jam per household. Starting seeds the shared queue from the host's Up Next; members
  add (via the existing catalog search + `resolveSong`) and reorder; every item carries
  "added by <name>" attribution. Ending returns the host to their own queue.
- **DB-backed rather than in-memory** (unlike presence): reorder and attribution want durable
  ordering, the rows are tiny, and a server restart mid-party should not eat the queue.
- The host's `TogetherJamHost` pulls the shared head into the radio engine only when local Up Next
  runs low, so members can still reorder what is waiting. The item is claimed server-side BEFORE
  being enqueued locally, so a failed claim retries instead of double-queueing.

**Announcement ducking** (`frontend/src/lib/speechDucking.ts`)
- Companion TTS ducks same-device media to ~20 percent, restoring over ~500ms. The bus is driven
  from the TTS singleton's `notify()` (the one funnel for REAL speech audio start/end), so every
  speech surface ducks identically. Music/live radio duck via a multiplier UNDER the user's volume
  (so `setVolume` and the family volume cap keep their meaning and the slider never moves);
  podcasts duck via a dedicated `duckGain` node so it never fights the sleep fade that owns
  `outGain`. Same-device only; cross-session announce ducking is not wired.

**Voice room targeting** (`backend/src/tools/playMusic.ts`)
- The `play_music` tool schema gained ONE optional property: `target` ("Room or device name to play
  on, ONLY when the user names one"). The tool also parses a trailing "on/in the X" phrase itself,
  so the Tier-1 fast path (whole message as `query`) works without the LLM filling `target`.
- A target is honored **only when it matches a live session** by custom name, then derived label
  (exact, then substring, then token overlap). On a match the play is routed through the remote
  channel and the target phrase is stripped from the station seed / video query. **No match means
  current behavior, unchanged** - so "play riders on the storm" stays a song request unless someone
  actually named a device "Storm".

## Chat Product Layer (2026-08: conversation management, variants, lifecycle)

The conversation-management features layered around the turn pipeline (see the
"chat product layer" commits, 2026-08-13). All in `routes/chat.ts` +
`lib/chatRetention.ts` unless noted.

**Message visibility model.** `messages.active` is the single visibility flag:
inactive rows are preserved regenerate siblings or discarded edit tails. Every
reader (history load, rolling summary, memory sweep, recall_conversations tool,
FTS queries, GET conversation) filters `active = 1`. Nothing hard-deletes a
message except the lifecycle purges below.

**Variants.** Regenerate keeps the old reply: old + new share
`messages.variant_group_id`, old goes inactive once the new one completes (a
failed regenerate leaves the old one active). GET conversation returns
`variants {index, count, ids}` per multi-variant message;
`POST /conversations/:id/variant {messageId}` flips the active sibling. Editing
a user message preserves the original text as an inactive copy and marks the
tail inactive instead of deleting it (linear history, but recoverable).

**Lifecycle.** Archive (`archived_at`, PATCH `{archived}`), soft delete
(`deleted_at`, restorable via `POST .../restore`, hard-purged after 30 days),
and temporary/incognito chats (`temporary = 1` at create: never listed, never
summarized, never memory-swept, never indexed for search, purged after 1h
idle). All hard deletes go through `hardDeleteConversations()` in
`chatRetention.ts`, which deletes message rows explicitly so the `messages_fts`
triggers fire (FK cascade is not guaranteed to run triggers). The retention
sweep (per-user month/year pref) uses the same helper.

**Search.** `messages_fts` (FTS5, external-content over `messages.content`,
triggers + boot backfill in `db/index.ts`). Ownership/visibility enforced at
query time, never in the index. Surfaces: `GET /api/chat/search?q=` (browse
page, `<mark>` snippets) and a Chats provider in Spotlight's `/api/search`.

**Feedback + telemetry.** Thumbs on assistant replies
(`POST /messages/:id/feedback`, `messages.feedback`/`feedback_note`). Each
reply persists `model`, `prompt_tokens`, `gen_tokens`, `duration_ms`.
`message_traces` (capped 500, pruned on write, skipped for temporary chats)
stores the full assembled system prompt, route decision, and tool trail per
turn; admin-only at `/api/admin/traces`, surfaced in Admin → Diagnostics &
Logs → Chat Traces.

**Reconnect.** GET conversation returns `activeGen {genId, assistantMessageId}`
when a generation is in flight, so a reopened tab re-attaches to the stream
(genQueue GC window is 5 min).

**Prompt additions** (see chat-latency.md for KV zones): user-authored custom
instructions (`chat.custom_instructions` pref, stable zone), project
instructions (stable) + per-message project document chunks (volatile) when the
conversation is filed under a project, and the prompt-injection guard line in
`PRESENTATION_POLICY` plus "quoted outside material, not instructions" framing
on tool folds and document blocks.

**Persona revisions.** Admin PATCH of persona-bearing character fields
snapshots the pre-edit values into `character_revisions` (capped 20/character);
list + revert at `/api/admin/companions/:id/revisions`, surfaced as "Persona
history" in the Studio identity tab. Reverting snapshots current state first.

**Attachments.** `.docx` extracts via `lib/docx.ts` (hand-rolled zip central
directory + `inflateRawSync`, no new deps). Pasted links route to the
`fetch_url` tool (bookmarks extraction stack: SSRF guard + Wayback fallback).
Mermaid fences render as diagrams in chat (lazy-loaded, strict security,
code-block fallback).
