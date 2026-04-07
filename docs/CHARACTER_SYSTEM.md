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
- `builtin` characters are **editable in place** by admins (no copy-on-write). The seeder is insert-if-missing so edits survive reboots. Escape hatch: `POST /characters/admin/{id}/reset-to-builtin` re-applies the `BUILTIN_SPECS` entry. Builtins still cannot be **deleted** — otherwise the seeder would silently recreate them on next boot.
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

> **Status legend:** ✅ shipped · 🟡 partial · ⬜ not started · 🚫 blocked

### Phase 0: Audit & Design — ✅ DONE
- [x] Inventory existing TTS / voice / wake-word code in [lokidoki/](../lokidoki/).
- [x] Confirm Piper phoneme event support — `audio.py:122-137` already yields `phonemes` + `samples_per_phoneme` per chunk. **Phase 5 unblocked from the backend side.**
- [x] Confirm DiceBear collection names — `avataaars`, `bottts`, `toonHead` (camelCase JS export, kebab-case `toon-head` URL/storage form). Single mapping point lives in `frontend/src/components/character/Avatar.tsx`.
- [x] Confirm legacy "personality" plumbing — `data/settings.json:user_prompt` flows through `Orchestrator(user_prompt=…)` into the **synthesis** prompt builder only; decomposer never sees it.

### Phase 1: Data & API Foundation — ✅ DONE
- [x] SQLite tables: `characters`, `voices`, `wakewords`, `character_overrides_user`, `character_settings_user`, `character_enabled_global`, `character_enabled_user` ([memory_schema.py](../lokidoki/core/memory_schema.py)).
- [x] Two-tier shape mirrors `skill_config_*` — admin-managed catalog + per-user overrides + per-user active pointer + per-user access flags.
- [x] CRUD ops in [character_ops.py](../lokidoki/core/character_ops.py): create/get/list/update/delete, builtin copy-on-write, override UPSERT/clear, active-character resolution with visible-builtin fallback.
- [x] Access tier in [character_access.py](../lokidoki/core/character_access.py): global enable + per-user enable, batch `filter_visible_ids`, `list_user_access_matrix`.
- [x] FastAPI routes ([characters.py](../lokidoki/api/routes/characters.py)) under `/api/v1/characters`:
  - `GET /` (visible list + active id), `GET /active`, `POST /active` (403 if not visible)
  - `PUT /{id}/override`, `DELETE /{id}/override`
  - Admin: `GET /admin/catalog`, `POST /admin`, `PATCH /admin/{id}` (cow), `DELETE /admin/{id}`
  - Admin access: `POST /admin/{id}/enable`, `GET /admin/users/{uid}/access`, `POST /admin/users/{uid}/characters/{cid}/enable`
- [x] Orchestrator wiring — `chat.py` resolves the active character per-user and passes its merged `behavior_prompt` as `user_prompt=` to `Orchestrator`. Synthesis-only injection is preserved by existing `orchestrator_skills.py` structure (decomposer never receives it).
- [x] Idempotent builtin seeding + first-boot personality migration ([character_seed.py](../lokidoki/core/character_seed.py)). Runs in `MemoryProvider.initialize`. Migration gated by `app_secrets` flag.
- [x] Legacy-table cleanup in `memory_init.py` (drops empty pre-Phase-1 `characters`/`wakewords` tables that lacked the new columns).
- [x] Tests: 22 unit tests in [test_characters.py](../tests/unit/test_characters.py) covering schema, CRUD, copy-on-write, override merge, active-pointer fallback, access tiers, batch visibility, deleted-active fallback.

### Phase 2: Voice & WakeWord Engine — ⬜ NOT STARTED
*Prerequisite for Phase 4's full provisioning UX. Schema tables already exist (empty); the asset registry layer + admin UI is the gap.*
- [ ] `VoiceRegistry` service tracking Piper model installation status (`installed`/`missing`/`downloading`) on disk + DB.
- [ ] Piper voice download pipeline (URL → `data/voices/{id}.onnx` → checksum verify → mark `installed`).
- [ ] `OpenWakeWord` integration layer for `.tflite` model loading.
- [ ] Admin endpoint: `.tflite` upload with size cap + magic-byte validation + controlled storage dir.
- [ ] **Admin → Audio Assets** tab in the frontend for installing Piper voices and uploading wake words.
- [ ] Surface voice/wakeword binding fields in [CharacterPlayground.tsx](../frontend/src/components/admin/CharacterPlayground.tsx) (currently deferred — placeholder noted in the "voice (Phase 2)" tagline).
- [ ] Tests: mock VoiceRegistry, no-network provisioning paths, `.tflite` magic-byte validation, storage budget enforcement.

### Phase 3: React Character Playground (Admin) — ✅ DONE
- [x] Integrated `@dicebear/core` + `@dicebear/collection` in the frontend.
- [x] Reusable [Avatar.tsx](../frontend/src/components/character/Avatar.tsx) — schema-aware option filtering (prevents cross-style key contamination — was the v1 toon-head bug), `toDataUri()` + `<img>` rendering with `object-contain` letterbox, error fallback placeholder.
- [x] Schema introspection module [styleSchemas.ts](../frontend/src/components/character/styleSchemas.ts) — flattens each style's `schema.js` into a uniform `SchemaField[]` shape.
- [x] Generic [SchemaField.tsx](../frontend/src/components/character/SchemaField.tsx) renderer — boolean toggle, integer slider, color-array swatches, enum-array single-select chips.
- [x] Three-pane [CharacterPlayground.tsx](../frontend/src/components/admin/CharacterPlayground.tsx): live preview (320px) + style picker + seed/Lucky controls · prompt editor · schema-driven options panel grouped Common / Style-specific.
- [x] Per-style option memory — switching styles preserves each style's settings independently (`optionsByStyle: { avataaars, bottts, "toon-head" }`).
- [x] Auto-bump `*Probability` to 100 when user single-selects an enum that has a probability companion (so picking `accessories: round` actually shows glasses, not 10%-of-the-time glasses).
- [x] Light checkered preview backdrop so styles with no default `backgroundColor` (toon-head) are visible.
- [x] Onyx Material aesthetic via existing tokens (`bg-card`, `border-border`, `bg-primary`, `shadow-m{1..4}`).
- [x] Admin catalog table ([CharactersAdminSection.tsx](../frontend/src/components/admin/CharactersAdminSection.tsx)) with real 36px avatars, global on/off toggle, edit (cow), delete (blocked on builtins via `ConfirmDialog`).
- [x] Per-user access matrix ([CharacterUserAccessMatrix.tsx](../frontend/src/components/admin/CharacterUserAccessMatrix.tsx)) — allow/deny/inherit per character per user.
- [ ] **REMAINING:** Voice/wakeword binding fields (blocked on Phase 2).
- [ ] **REMAINING:** Component-level frontend tests (none yet — only the backend has unit tests).
- [ ] **OPTIONAL POLISH:** Custom hex color picker in `SchemaField` (currently swatch-only from each schema's default palette); specialized two-value enum renderer for fields like `backgroundType` (currently uses the generic enum-array control).

### Phase 4: User Selection & Provisioning — 🟡 PARTIAL
- [x] User-facing **Character Picker** in Settings ([CharactersSection.tsx](../frontend/src/components/settings/CharactersSection.tsx)) — card grid with 64px live avatars, click to set active, per-user behavior_prompt textarea override + reset-to-catalog button.
- [x] Visibility-filtered list — `GET /api/v1/characters` only returns characters visible to the calling user (admin global toggle AND per-user override).
- [x] Per-user override UI for `behavior_prompt`. (Schema supports overriding `name`, `phonetic_name`, `description`, `behavior_prompt`, `avatar_style`, `avatar_seed`, `avatar_config` — only `behavior_prompt` is exposed in the user UI today. Easy to extend.)
- [ ] **REMAINING:** "One-Click Install" provisioning flow (download voice + wakeword for the picked character) — blocked on Phase 2's `VoiceRegistry`.
- [ ] **REMAINING:** UI feedback for asset downloads — progress bars, retry, cancel.
- [ ] **REMAINING:** Deferred-intro fallback rule — if the picked character's voice isn't installed yet, use the global system voice for general TTS but defer the "I am [X]" introduction.
- [ ] **REMAINING:** Storage-budget GC (voices unused for N days, prompted before delete).
- [ ] **REMAINING:** Tests for provisioning failure modes, fallback voice, cancellation cleanup.

### Phase 5: Animated Avatar Integration — 🟡 PARTIAL
*Phase 0 confirmed phoneme events ARE emitted by `audio.py`. The viseme pipeline is now end-to-end live.*
**Architecture decision:** stayed with the data-URI `<img>` render path. DiceBear's `createAvatar()` is synchronous JS (no network) so re-deriving the URI on every viseme tick is cheaper than parsing inline SVG and walking it for per-element transforms — and it sidesteps the toon-head dark-background bug that drove the original data-URI choice. Mouth + eye swaps happen at the DiceBear-options layer instead of the SVG layer.
- [x] Salvaged & adapted from old project (`/Users/jessetorres/Projects/loki-doki`): the IPA→viseme mapping and 38 ms-lead scheduler in [VoiceStreamer.ts](../frontend/src/utils/VoiceStreamer.ts) (already in tree, pre-Phase-5). Old project's `ExpressionResolver.ts`, `AnimatedCharacter.tsx` doze state machine, and the entire RiggingSection / QuantumRigging suite were **scrapped** — they were built for hand-rigged custom SVG (KyleSouthPark) and don't apply to DiceBear's enum-driven mouth/eye system.
- [x] Viseme→DiceBear-mouth resolver: [visemeMap.ts](../frontend/src/components/character/visemeMap.ts) with verified enum values for `avataaars`, `bottts`, `toon-head` (enum lists pulled directly from each style's `lib/schema.js`). Includes per-style blink-eye fallback (avataaars=`closed`, toon-head=`wink`, bottts=null because none of its eye variants read as blinking).
- [x] TTSController wiring: [tts.ts](../frontend/src/utils/tts.ts) now constructs `VoiceStreamer` with viseme + end callbacks and exposes `subscribeViseme(fn)`. Subscribers get the current value pushed synchronously on subscribe so first paint is consistent. End-of-stream snaps mouth back to `closed`.
- [x] [AnimatedAvatar.tsx](../frontend/src/components/character/AnimatedAvatar.tsx) renders the DiceBear data-URI **twice, stacked**: a body layer (mask hides head region) and a head layer (mask shows only head, rotated around a per-style neck pivot from [headRig.ts](../frontend/src/components/character/headRig.ts)). Because both layers share an identical `src`, the seam is invisible — only the head image sweeps when rotated, the torso stays planted. A 4-5% feathered mask gradient hides any residual ghosting at ±8°. Lipsync/blink option swaps drive both layers from the same `effectiveOptions`. Drop-in for any place that wants liveness — the static plain `<Avatar>` is still preferred for grid thumbnails to avoid N subscriptions.
- [x] Head rotation is **state-driven** via [useHeadTilt.ts](../frontend/src/components/character/useHeadTilt.ts) — a rAF + LERP loop with per-state profiles (`idle`, `dozing`, `sleeping`, `thinking`, `listening`, `speaking`, `sick`). Each profile defines a center angle, sine amplitude, period, and smoothing factor. When `tiltState` changes the displayed angle eases to the new target instead of snapping. v1 only wires `idle`; the other states are implemented and ready for follow-up wiring (TTS-active → speaking, inactivity → dozing, decomposer-thinking → thinking).
- [x] Mounted in [ChatPage.tsx](../frontend/src/pages/ChatPage.tsx) as a 28×28 floating widget in the top-right corner of the chat pane. Loads the active character on mount and refetches whenever `dataVersion` bumps (so picking a new character in Settings updates the chat avatar without a reload).
- [ ] **REMAINING:** Crossfade transition when switching characters mid-conversation (today the swap is a hard cut).
- [ ] **REMAINING:** Tests for `visemeMap` (style enum coverage) and `AnimatedAvatar` (subscribe/unsubscribe lifecycle, blink-disabled path for bottts).
- [ ] **REMAINING:** Optional eye-saccade idle (random `looking_left`/`looking_right` shifts) — old project had this; deferred until we see whether the blink+sway alone reads as alive.

---

## 7. Open Questions / Verification

### Resolved
- [x] **Does `audio.py` emit per-phoneme timing events?** Yes — `audio.py:122-137` yields `{audio_pcm, sample_rate, phonemes, samples_per_phoneme}`. Phase 5 unblocked.
- [x] **DiceBear collection name for `toon-head`?** Package exports as `toonHead` (camelCase). We store as `toon-head` (kebab-case, matching DiceBear's URL convention) and map at the single boundary in `Avatar.tsx`.

### Still open
- [ ] **On-disk storage budget for voices on Pi 5.** Drives Phase 4's GC policy default. Needs hardware validation against the target SD card configuration.
- [x] **Default builtin character set — how many ship in v1?** Three, one per shipped DiceBear style. All seeded idempotently by name in [character_seed.py:BUILTIN_SPECS](../lokidoki/core/character_seed.py) — re-running the seed updates the catalog row in place without breaking per-user overrides (FK on `id`, not `name`).

  | Name | Style | Seed | Notes |
  | :--- | :--- | :--- | :--- |
  | **Loki** | `bottts` | `Ryker` | `baseColor=["00cc66"]` (computer/terminal green body). Friendly, warm, playful default. |
  | **Kingston** | `toon-head` | `Kingston` | Cartoon companion, soft encouraging tone. |
  | **Luis** | `avataaars` | `Luis` | Human-style assistant, plain & approachable. |

  Reference renders match the DiceBear playground URLs `https://api.dicebear.com/9.x/{style}/svg?seed={seed}` exactly (the JS SDK uses the same seed → identical output). Builtins are **edited in place** by admins (copy-on-write removed); the seeder is insert-if-missing so edits survive reboots. To restore a builtin to the spec above, click **Reset to Default** in the playground (`POST /characters/admin/{id}/reset-to-builtin`).
- [ ] **Should `voice_id` / `wakeword_id` be user-overridable?** Currently NO (per [character_ops.py:USER_OVERRIDABLE](../lokidoki/core/character_ops.py)) — those bind to admin-controlled on-disk assets and would break the storage-budget rules. Worth revisiting once Phase 2 lands.
- [ ] **Per-project character override** — schema deliberately leaves room (§3.1 future scope). Decide if/when to add `projects.character_id` FK once Phase 4 provisioning settles.
