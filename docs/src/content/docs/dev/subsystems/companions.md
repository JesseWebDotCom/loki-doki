---
title: Companion System
description: DiceBear avatar engine, CompanionOverlay, the Companion Store, per-user grants, voice resolution, and lip-sync.
sidebar:
  order: 2
---

## Overview

The companion system is the floating AI "buddy" that lives at the bottom of every page. A companion is a `characters` row with a personality prompt, a voice, an avatar, a content config, and a store category. The behavior engine is **renderer-agnostic**: the `renderer` column selects the avatar engine and `dicebear` is the only one implemented today, but the rigging (head tilt, lip-sync, moods) is decoupled so a future `rive`/`vrm` renderer can drop in.

The product ships a default roster (see `backend/src/lib/defaultCompanions.ts`) so there is always someone to talk to, and surfaces an App-Store-style browser at `/companions` (the **Companion Store**) for choosing and favoriting them.

---

## Avatar Engine

**Engine:** DiceBear (via `@dicebear/core` + style packages), rendered by `RiggedDicebearAvatar`.

`CharacterAvatar` (`frontend/src/components/companion/CharacterAvatar.tsx`) is the reusable animated buddy. It maps high-level chat signals (`streaming`, `thinking`, `listening`, `sleeping`, `mood`) to a `HeadTiltState` via `deriveTilt`, then hands a DiceBear `style` / `seed` / `avatarConfig` to `RiggedDicebearAvatar`.

The DiceBear SVG is post-processed (`splitDicebearSvg.ts`) so the head group is split into its own SVG group (`.ld-head-rot`) and can be rotated independently for the head-tilt behavior:

```css
.ld-head-rot {
  transform-box: fill-box;
  transform-origin: 50% 62%;
  transform: rotate(var(--ld-head-rotate, 0deg));
}
```

`fill-box` (bounding box of the element itself) makes the head cock around its own center rather than the SVG viewport origin. Only the specific head group class is targeted so a broad `id` selector cannot double-rotate nested hair/eyebrow parts.

The `style` value is a DiceBear collection name (e.g. `avataaars`, `bottts`, `toon-head`); `coerceStyle` maps it to a loaded style package. `avatarConfig` is the full DiceBear rigging options blob (stored as a JSON string in the `avatar_config` column, parsed back out by `toCompanionPayload`).

---

## Companion Overlay

`CompanionOverlay` (`frontend/src/components/shell/CompanionOverlay.tsx`) is a **global floating overlay**: it is mounted in `AppShell`, persists across all pages, and is anchored bottom-center (`z-[9999]`). It has three display modes (picked from the companion menu):

- **Mini** (`pill`): a tiny pill; hovering reveals a composer above it.
- **Docked** (`collapsed`): avatar plus composer.
- **Max** (`expanded`): avatar plus composer plus the voice / hands-free / captions indicator row.

Other overlay behaviors:

- **Global input.** `⌘/` (`Ctrl+/`) focuses the companion composer from anywhere (the chat-input analogue of `⌘K` search); in Mini mode it first reveals the pill's composer.
- **Idle orb.** When no companion is selected, the overlay renders `CompanionOrb`, a canvas pixel orb that pulses/breathes/sparkles to show the system is alive.
- **Auto-sleep.** After 3 minutes of no AI activity and no user input, the companion goes dormant (`SleepingZs`); any input or AI activity wakes it.
- **Quick switch.** The companion menu surfaces up to 5 favorite avatars for one-tap switching, plus a link into the Companion Store and a "turn off companion" control.
- **Chat vs ephemeral.** On `/chat` the overlay mirrors the live chat stream; everywhere else it drives the ephemeral companion stream (`POST /api/companions/companion`), which persists nothing.

### Ephemeral companion stream

`POST /api/companions/companion` (`backend/src/routes/companions.ts`) is the off-chat "talk back in place" path. It persists **no** conversation or messages, only durable facts the memory extractor distills (fire-and-forget after the stream). It runs the same tool pipeline as main chat (news, web, weather), recalls long-term memory in parallel (cached per `companion:<userId>:<characterId>`), and injects the daily-briefing block, date, location, and friendship line into the system prompt. It is content-gated: a character whose dials exceed the effective ceiling returns `403`.

---

## Lip-Sync

The overlay drives the mouth two ways depending on whether Voice (read-aloud TTS) is on:

- **Audio-driven visemes (Voice on).** When `audioLipSync` is set, `CharacterAvatar` subscribes to `useCharacterViseme` and the mouth follows real TTS audio (`viseme-scheduler.ts` / `visemeMap.ts`, with an `amplitude-fallback.ts` path that rotates wide-vowel visemes per detected syllable).
- **Text-cadence flap (Voice off).** When TTS is off, the mouth flaps from the streamed token cadence and captions are revealed sentence-by-sentence at a readable pace (`useStreamingSentenceCaption`).

`talkActive` (indicator glow, captions, mouth) follows real audio playback when Voice is on, and the sentence-reveal cadence otherwise.

---

## Voice Resolution

Per-character voice resolution lives in `backend/src/lib/voice/voiceResolver.ts`:

```
character voice → user default voice → app catalog default
```

`ttsVoice` is a qualified `engine:voice_id` (the default roster uses Kokoro ids like `kokoro:am_michael`). A character with no `ttsVoice` falls back to the user's voice, then the app-wide default. Wake words follow a similar per-character pattern: a trained `wakeWordModelId` always wins over a free-text `wakeWordPhrase`, and the two are kept mutually exclusive on write.

---

## Companion Store

The store is a nested sub-app at `/companions` (`CompanionStoreLayout` in `frontend/src/App.tsx`), mirroring the App Store's structure. Routes:

| Path | Page |
| --- | --- |
| `/companions` | `CompanionHomePage` (featured hero, categories, recommended, all) |
| `/companions/browse` | `CompanionBrowsePage` |
| `/companions/categories` | `CompanionCategoriesPage` |
| `/companions/category/:key` | `CompanionCategoryPage` |
| `/companions/favorites` | `CompanionFavoritesPage` |
| `/companions/c/:id` | `CompanionDetailPage` |

**Categories** (`frontend/src/lib/companions/companionCategories.ts`) are a declarative catalog (key, name, blurb, gradient, icon), but the **assignment** lives on each `characters.category` row so admin-authored companions categorize too. The six categories: `everyday` (Everyday & Assistants), `coaches` (Coaches & Mentors), `family` (Family & Kids), `wellness`, `creative`, and `mature` (Mature 18+, flagged so the gate renders locked members with an 18+ affordance).

**Detail page** shows a category-gradient hero, an App-Store-style stat row (Voice/Gender/Style/Pace/Rating), the full personality prompt, mature-content dial badges, and Select / Preview / Favorite actions. A locked companion (content config exceeds the effective ceiling) shows a "Locked, requires ..." label instead of Select.

**Favorites** are stored in the user preference `companion.favorites` (a JSON string array of character ids) via `GET`/`PUT /api/companions/favorites`. The active companion is the preference `companion.active_character_id` (`GET`/`PUT /api/companions/active`).

---

## Default Roster Reconciliation

`DEFAULT_COMPANIONS` in `backend/src/lib/defaultCompanions.ts` is the shipped roster: **25 companions** spread across all six categories (`everyday` 5, `coaches` 3, `family` 8, `wellness` 3, `creative` 3, `mature` 3). Each seed carries a persona prompt, backstory, reply style, DiceBear style/seed/avatarConfig, a Kokoro voice, a wake phrase, a speech rate, and content dials.

`ensureDefaultCompanions(createdBy)` runs once per process (guarded by `seedChecked`) and is called at the top of the companion list routes. It is idempotent and reconciles in two steps:

1. **Insert** any defaults not already present (matched by lowercased name); this covers fresh DBs and newly added roster members.
2. **Backfill** NULL fields (`category`, `ttsVoice`, `wakeWordPhrase`, `speechRate`, `contentDials`) on existing default-named rows without clobbering admin customizations.

The three `mature` companions (`Lux`, `Velvet`, `Raven`) carry elevated dials, so they **publish** but render LOCKED until the user's content ceiling allows them.

---

## Admin Studio

**Admin → Companions → Characters** (`AdminCompanionsTab`, registered in `adminRegistry.ts`) is the studio:

- Create / edit / delete companions (`POST` / `PATCH` / `DELETE /api/admin/companions`)
- Avatar style picker (DiceBear style + seed + `avatarConfig` params)
- Personality prompt editor + reply style
- Voice assignment (`ttsVoice`) and content dials
- Wake word (trained model id or free-text phrase, mutually exclusive)
- Global gates: `enable` (`isActive`) and `publish` (`published`)
- Per-user grant management
- A live tester (`POST /api/admin/companions/test`) that streams an Ollama reply for an unsaved draft persona without persisting anything

---

## Per-User Grants

Companions use a **default-visible** permission model (`getVisibleCompanions`):

- Active (`isActive`) + published companions are visible to all users by default.
- Per-user revocations are stored in `character_user_grants` with `state = 'off'`; absence of a row means granted.
- Admins see all companions regardless of publish/active state.

Layered on top, a per-user **content gate** (`characterGate` against the effective ceiling = stricter of admin and user) marks a companion as locked when its dials exceed what the user is allowed; the list endpoint attaches this `gate` to each payload.

---

## Wake Word Per Companion

Each companion can carry its own wake word: either a trained `wakeWordModelId` or a free-text `wakeWordPhrase` (Whisper-matched, no model download/training). Saying it activates that companion's overlay and voice. See the [Voice system](/dev/subsystems/voice/) for the hands-free FSM that consumes it.

---

## DB Tables

Companion data lives in tables named `characters` / `character_user_grants` / `user_characters`; the schema retains these names to avoid migrations while the API and UI surface everything as "companion". Key `characters` columns: `renderer` (default `dicebear`), `style`, `seed`, `avatar_config` (JSON), `personality_prompt`, `reply_style`, `tts_voice`, `wake_word_model_id`, `wake_word_phrase`, `speech_rate`, `content_dials` (JSON), `category`, `is_active`, `published`.
