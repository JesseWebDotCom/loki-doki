# LokiDoki Character System Design Document

## 1. Goal
Create a modular system where users can choose from pre-configured "Characters" that define the bot's visual appearance (DiceBear), personality (LLM instructions), voice (Piper), and wake word (OpenWakeWord). Administrators can build and manage these characters through a modern, interactive playground.

## 2. Core Components

### 2.1. Visual Identity (DiceBear)
- **Styles**: `avataaars`, `bottts`, and `toon-head` (collection names match `@dicebear/collection` package exports exactly — no translation layer).
- **Renderer**: React-based DiceBear renderer using standard options.
- **Seed**: Each character stores its DiceBear `seed` so randomized looks are reproducible across reloads and exports.
- **Animation**: Basic viseme-based animation (mouth movement) synced with Piper TTS phoneme events. **Dependency**: Phase 5 is blocked until phoneme event emission is verified in `audio.py` (see §7).

### 2.2. Voice Identity (Piper TTS)
- **Selection**: Admin can choose from multiple Piper ONNX voices.
- **Phonetics**: Custom phonetic spelling for the character's name to ensure correct pronunciation during "I am [X]" introductions. Phonetics are tied to the selected voice's locale; switching voice locales may invalidate the phonetic spelling.
- **Permissions**: Voices can be marked as "Global" (available to all characters) or "Exclusive" (only for specific characters).

### 2.3. Personality (LLM Prompting)
- **Name**: The display name of the character.
- **Description**: A short (<10 word) tagline visible in the selection menu.
- **Behavior Prompt**: System instructions specific to the character (e.g., "Speak like a helpful robot with a slight glitch").
- **Injection point**: `behavior_prompt` is injected **only into the synthesis (9B) system prompt**. It must NOT reach the decomposer (2B), which emits structured JSON and would be polluted by personality directives.
- **Replaces Settings → Bot Personality (Tier 2)**: The existing Settings "Bot Personality" field becomes a **dynamic read** from the active character's `behavior_prompt` rather than a standalone user-editable string. Admin rules (Tier 1) still take precedence over character behavior.
- **Migration**: On first boot after this change, any existing user-customized Tier 2 personality text must be preserved by seeding it into a `user`-source character so users don't lose their tuning.

### 2.4. Wake Word (OpenWakeWord)
- **Assignment**: Each character can be tied to a specific wake word.
- **Management**: Admins can upload `.tflite` OWW models or select from defaults.
- **Collision rule**: If two characters share a wake word, the most-recently-selected character wins. Documented limitation, not an error.

---

## 3. Data Model (Proposed)

### Character Schema
| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `UUID` | Primary identifier. |
| `name` | `String` | Display name. |
| `phonetic_name` | `String` | Phonetic spelling for TTS (locale-dependent on `voice_id`). |
| `description` | `String` | Short tagline (<10 words). |
| `behavior_prompt` | `String` | System instructions for synthesis LLM. |
| `avatar_style` | `Enum` | `avataaars`, `bottts`, `toon-head`. |
| `avatar_seed` | `String` | DiceBear seed for reproducible randomization. |
| `avatar_config` | `JSON` | Options for the DiceBear style (colors, eyes, etc). |
| `voice_id` | `FK → voices.id` | Nullable FK; falls back to global system voice when missing. |
| `wakeword_id` | `FK → wakewords.id` | Nullable FK. |
| `source` | `Enum` | `builtin` (shipped), `admin` (admin-created), `user` (user-created). Replaces prior `is_preconfigured` boolean. |
| `created_at` | `Timestamp` | |
| `updated_at` | `Timestamp` | |

### Voice Schema
| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `String` | Piper ID (e.g., `en_US-lessac-medium`). |
| `display_name` | `String` | Human-readable name. |
| `is_global` | `Boolean` | If true, user can see it in general settings. |
| `status` | `Enum` | `installed`, `missing`, `downloading`. |

### WakeWord Schema
| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `String` | Stable identifier. |
| `display_name` | `String` | Human-readable name. |
| `file_path` | `String` | Path to `.tflite` model on disk. |
| `is_global` | `Boolean` | Available to any character. |
| `status` | `Enum` | `installed`, `missing`, `downloading`. |

### Settings
- `active_character_id` (`FK → characters.id`) — global active character. **One active character at a time** in v1.

---

## 3.1 Scope & Non-Goals

### v1 (in scope)
- One globally active character.
- Admin CRUD for characters, voices, wake words.
- Auto-provisioning of voice/wakeword on character selection.

### Future (documented, not built in v1 — but schema must leave room)
- **Per-project character override**: add a nullable `project.character_id` FK that falls back to the global `active_character_id` when null. Calling this out now so the v1 schema does not paint us into a corner.

### Non-goals
- No per-message character switching.
- No LLM voice cloning.
- No animated 3D avatars.
- No automatic resolution of wake word collisions beyond "last-selected wins".

---

## 4. Administrative Experience

### Character Playground
A modern, visual editor inspired by the DiceBear playground, built on **`shadcn/ui` primitives** and the **Onyx Material** design system (Elevation Levels 1–4, Material Purple accents, Onyx foundations — per `CLAUDE.md`):
- **Style Selector**: Toggle between `avataaars`, `bottts`, and `toon-head`.
- **Live Preview**: Real-time rendering of the avatar as options are changed.
- **Randomizer**: "Lucky" button that generates a new `avatar_seed`.
- **Prompt Editor**: Text areas for name, phonetic name, description, and behavior.
- **Model Check**: Indicators for whether the assigned voice/wakeword is ready on disk.

### Character Lifecycle Rules
- `builtin` characters cannot be edited or deleted directly. Editing one performs a **copy-on-write** into a new `admin`-source character.
- `admin` and `user` characters can be edited and deleted freely.
- Deleting the currently active character falls the system back to a designated default `builtin` character.

### `.tflite` Upload Validation
- Admin-only endpoint.
- Enforce a size cap (e.g., 5 MB).
- Validate file magic bytes match TFLite format before persisting.
- Store under a controlled directory; never execute or `eval`.

---

## 5. User Experience

### Selection Flow
- Located in **Settings > Appearance**.
- **Character Cards**: Grid view showing the name, description, and a preview of the avatar.
- **Auto-Provisioning**: Selecting a character triggers a background task to ensure the required Voice and WakeWord are downloaded/installed.
  - **Failure states**: no network, disk full, checksum mismatch — surface a clear error in the UI.
  - **Retry**: user-initiated retry button on failed assets.
  - **Cancellation**: user can cancel an in-flight provision; partial downloads are cleaned up.
- **Fallback**: If a voice is missing at selection time, the system uses the global system voice for general TTS but **defers the "I am [X]" introduction** until the character's real voice is installed. (Speaking the intro in the wrong voice would break the identity premise.)

### Storage Budget (Raspberry Pi 5)
- Piper voices range ~20–100 MB; OWW models are smaller.
- Default cap on total voice storage (configurable in admin settings).
- **GC policy**: voices not referenced by any character and not used in the last N days are eligible for cleanup; user is prompted before deletion.

---

## 6. Phased Implementation Plan

### Phase 0: Audit & Design
- [ ] Inventory existing TTS / voice / wake-word code in [lokidoki/](../lokidoki/) as **reference only** — existing code may be unoptimized or broken; do not assume it is load-bearing.
- [ ] Determine the best design and reuse only what genuinely fits. Rewrite freely where the existing implementation is weak.
- [ ] Confirm Piper phoneme event support in the current `audio.py` SSE pipeline (blocks Phase 5).
- [ ] Confirm DiceBear collection names exactly (`avataaars`, `bottts`, `toon-head`).

### Phase 1: Data & API Foundation
- [ ] Implement SQLite tables for `characters`, `voices`, and `wakewords` per §3.
- [ ] Add `settings.active_character_id`.
- [ ] Build FastAPI routes for Character CRUD (admin-gated).
- [ ] Update `orchestrator.py` to inject the active character's `behavior_prompt` into the **synthesis** system prompt only. Wire the Settings → Bot Personality (Tier 2) read to flow from the active character.
- [ ] Migration: seed any existing user Tier 2 personality text into a `user`-source character.
- [ ] Tests (TDD-first): fixture characters, CRUD round-trip, orchestrator injection assertions, decomposer-pollution regression test.

### Phase 2: Voice & WakeWord Engine (prerequisite for full Phase 1 provisioning UX)
- [ ] Implement a `VoiceRegistry` to track installation status of Piper models.
- [ ] Add `OpenWakeWord` integration layer to backend.
- [ ] Create an "Admin > Audio Assets" tab for uploading `.tflite` files and installing Piper voices.
- [ ] Tests: mock voice registry; no-network provisioning paths; `.tflite` validation.

### Phase 3: React Character Playground (Admin)
- [ ] Integrate `@dicebear/core` and collections in the frontend.
- [ ] Build the `CharacterEditor` component with live SVG preview.
- [ ] Add controls for voice/wakeword mapping.
- [ ] Implement the Onyx Material aesthetic via `shadcn/ui` primitives.
- [ ] Tests: component rendering, seed reproducibility, copy-on-write of `builtin` characters.

### Phase 4: User Selection & Provisioning
- [ ] Build the user-facing "Character Picker" in Settings.
- [ ] Implement the "One-Click Install" logic (backend handles parallel downloads of voice/wakeword).
- [ ] Add UI feedback (progress bars, retry, cancel) for downloading assets.
- [ ] Implement the deferred-intro fallback rule.
- [ ] Tests: provisioning failure modes, fallback voice behavior, cancellation cleanup.

### Phase 5: Animated Avatar Integration
- [ ] **Blocked until Phase 0 confirms phoneme events.**
- [ ] Replace static avatar with an `AnimatedAvatar` component.
- [ ] Use SSE events from `audio.py` (visemes/phonemes) to drive simple CSS/SVG animations.
- [ ] Final polish on transitions when switching characters.

---

## 7. Open Questions / Verification
- [ ] Does the current `audio.py` SSE pipeline emit per-phoneme timing events from Piper? (Blocks Phase 5.)
- [ ] Do `@dicebear/collection` package exports include `toon-head` under that exact name, or does it need a different identifier?
- [ ] What is the on-disk storage budget for voices on the target Pi 5 SD card configuration?
- [ ] Default `builtin` character set: how many ship in v1, and who designs them?
