# LokiDoki Core — Audit & Legacy Port Plan

_Generated: 2026-04-08_  
_Last updated: 2026-04-08 (progress pass — see "Progress Log" at bottom)_

This document captures (1) a code-quality audit of `loki-doki-core` and (2) a survey of features in the legacy `/Users/jessetorres/Projects/loki-doki` project worth porting. Each section ends with a prioritized action list.

---

## Part 1 — Repository Audit

### 1.1 Standards Violations (CLAUDE.md)

#### Browser dialogs (forbidden — must use `ConfirmDialog`)
- [frontend/src/pages/AdminPage.tsx:123](frontend/src/pages/AdminPage.tsx#L123) — `confirm()` in `adminDeletePerson`
- [frontend/src/pages/AdminPage.tsx:154](frontend/src/pages/AdminPage.tsx#L154) — `confirm()` in `handleResetMemory`
- [frontend/src/pages/AdminPage.tsx:177](frontend/src/pages/AdminPage.tsx#L177) — `alert()` in `handleResetMemory`

**Fix:** Replace each with `frontend/src/components/ui/ConfirmDialog.tsx`.

#### Files exceeding the ~250-line ceiling (must refactor)

**Backend:**
- [lokidoki/core/decomposer_repair.py](lokidoki/core/decomposer_repair.py) — 800 lines
- [lokidoki/core/orchestrator.py](lokidoki/core/orchestrator.py) — 503 lines (docstring already flags refactor)
- [lokidoki/core/memory_provider.py](lokidoki/core/memory_provider.py) — 486
- [lokidoki/core/memory_sql.py](lokidoki/core/memory_sql.py) — 478
- [lokidoki/core/character_ops.py](lokidoki/core/character_ops.py) — 435
- [lokidoki/api/routes/admin.py](lokidoki/api/routes/admin.py) — 421
- [lokidoki/core/memory_schema.py](lokidoki/core/memory_schema.py) — 410
- [lokidoki/api/routes/memory.py](lokidoki/api/routes/memory.py) — 400
- [lokidoki/core/memory_people_sql.py](lokidoki/core/memory_people_sql.py) — 386
- [lokidoki/api/routes/characters.py](lokidoki/api/routes/characters.py) — 383
- [lokidoki/core/orchestrator_skills.py](lokidoki/core/orchestrator_skills.py) — 380
- [lokidoki/core/skill_config.py](lokidoki/core/skill_config.py) — 368
- [lokidoki/core/orchestrator_memory.py](lokidoki/core/orchestrator_memory.py) — 309
- [lokidoki/core/memory_search.py](lokidoki/core/memory_search.py) — 299
- [lokidoki/core/memory_people_ops.py](lokidoki/core/memory_people_ops.py) — 289

**Frontend:**
- [frontend/src/lib/api.ts](frontend/src/lib/api.ts) — 671 (split per-domain: chat, memory, admin, characters)
- [frontend/src/pages/AdminPage.tsx](frontend/src/pages/AdminPage.tsx) — 561
- [frontend/src/components/admin/CharacterPlayground.tsx](frontend/src/components/admin/CharacterPlayground.tsx) — 536
- [frontend/src/components/settings/SkillsSection.tsx](frontend/src/components/settings/SkillsSection.tsx) — 473
- [frontend/src/components/character/useHeadTilt.ts](frontend/src/components/character/useHeadTilt.ts) — 466
- [frontend/src/pages/ChatPage.tsx](frontend/src/pages/ChatPage.tsx) — 462
- [frontend/src/components/character/splitDicebearSvg.ts](frontend/src/components/character/splitDicebearSvg.ts) — 416
- [frontend/src/components/sidebar/Sidebar.tsx](frontend/src/components/sidebar/Sidebar.tsx) — 371
- [frontend/src/components/character/RiggedDicebearAvatar.tsx](frontend/src/components/character/RiggedDicebearAvatar.tsx) — 347
- [frontend/src/components/memory/PeopleTab.tsx](frontend/src/components/memory/PeopleTab.tsx) — 341
- [frontend/src/pages/MemoryPage.tsx](frontend/src/pages/MemoryPage.tsx) — 307
- [frontend/src/components/sidebar/ProjectModal.tsx](frontend/src/components/sidebar/ProjectModal.tsx) — 284
- [frontend/src/components/memory/FactRow.tsx](frontend/src/components/memory/FactRow.tsx) — 254

#### Open TODOs to close or ticket
- [lokidoki/api/routes/chat.py:123](lokidoki/api/routes/chat.py#L123) — `# TODO: filter facts by project_id?`
- [lokidoki/core/memory_schema.py:37](lokidoki/core/memory_schema.py#L37) — embeddings perf TODO

---

### 1.2 Incorrect / Risky Code

- [lokidoki/api/routes/tests.py:56](lokidoki/api/routes/tests.py#L56) — hardcoded mock timestamp `"2026-04-06T11:37:00Z"`. Replace with `datetime.now(timezone.utc).isoformat()`.
- [lokidoki/api/routes/tests.py:34-41](lokidoki/api/routes/tests.py#L34-L41) — weak `startswith("tests")` validation before subprocess. Replace with explicit allowlist `{"tests", "tests/unit", "tests/integration"}`.
- [lokidoki/api/routes/tests.py:11-16](lokidoki/api/routes/tests.py#L11-L16) — global mutable `last_run_results` dict; not concurrency-safe.
- [lokidoki/api/routes/admin.py:410](lokidoki/api/routes/admin.py#L410) — `ResetPinRequest.new_pin` has no length/complexity validation. Add `Field(..., min_length=4, max_length=20)`.
- Broad `except Exception` swallowing in:
  - [lokidoki/auth/passwords.py:46](lokidoki/auth/passwords.py#L46)
  - [lokidoki/auth/tokens.py:63](lokidoki/auth/tokens.py#L63)
  - [lokidoki/skills/weather_owm/skill.py:75](lokidoki/skills/weather_owm/skill.py#L75)
  - [lokidoki/skills/weather_openmeteo/skill.py:152](lokidoki/skills/weather_openmeteo/skill.py#L152)
  Catch specific exceptions instead (`bcrypt.InvalidHash`, `jwt.DecodeError`, `aiohttp.ClientError`).

---

### 1.3 Inefficient Code

- [lokidoki/api/routes/admin.py](lokidoki/api/routes/admin.py) — fact promote/reject/delete reload entire user memory after each call (N+1 on bulk admin actions). Batch or stream incremental updates.
- [lokidoki/core/orchestrator.py:496-497](lokidoki/core/orchestrator.py#L496-L497) — re-queries session title under the async lock after auto-name update; trust `update_session_title` rowcount instead.
- [lokidoki/core/memory_provider.py:65-68](lokidoki/core/memory_provider.py#L65-L68) — embeddings backfill runs synchronously inside `initialize()`. Move to a post-startup background task so resident-model load isn't delayed on Pi.
- [lokidoki/core/memory_provider.py:421-440](lokidoki/core/memory_provider.py#L421-L440) — single coarse `asyncio.Lock` serializes all writes across users. Consider per-user locks.

---

### 1.4 Dead / Wasteful Code

- [lokidoki/api/routes/tests.py](lokidoki/api/routes/tests.py) — entire route is orphaned; the `TestRunner` UI never calls it. Either wire it up or delete the route file.
- [lokidoki/core/memory_provider.py:485-486](lokidoki/core/memory_provider.py#L485-L486) and [lokidoki/core/memory_singleton.py:12](lokidoki/core/memory_singleton.py#L12) — module-level monkey-patching of methods onto `MemoryProvider`. Breaks IDE autocomplete and type checkers. Replace with composition or mixin inheritance.
- Repeated `PipelineEvent.to_sse()` JSON serialization across orchestrator yield sites — DRY into a helper.

---

### 1.5 Missing Tests

- No unit tests for admin routes (`/api/v1/admin/*`); cascade delete (person → facts) untested.
- No isolated unit tests for the spaCy validation helpers in `decomposer_repair.py` (`_is_propn_in_source`, `_is_name_in_relations`).
- No tests for `tests.py` route (and currently nothing that uses it).
- No Pi 5–specific regression test ensuring `ModelPolicy` paths actually run on the target hardware.

---

## Part 2 — Legacy `loki-doki` Features Worth Porting

Source root: `/Users/jessetorres/Projects/loki-doki`

### Tier 1 — Critical / High Value

| # | Feature | Source | Difficulty | Notes |
|---|---|---|---|---|
| 1 | **Piper TTS voice catalog + installer** | `app/providers/piper_service.py` | Moderate | Core has bare streaming synth only — missing curated catalog, HuggingFace upstream sync, install/remove/warm, custom ONNX support. |
| 2 | **OpenWakeWord wake-word detection** | `app/subsystems/voice/wakeword.py` | Hard | Completely absent in core. Required for hands-free use. |
| 3 | **Faster-Whisper full STT streaming** | `app/subsystems/voice/service.py` | Moderate | Core has stub `SpeechToText` only; legacy has chunked streaming + error handling. |
| 4 | **Push-to-talk voice turn workflow** | `app/subsystems/voice/workflow.py`, `app/api/voice.py` | Moderate | End-to-end audio→STT→LLM→TTS orchestration. |
| 5 | **Face recognition (ArcFace + InsightFace buffalo_sc)** | `app/subsystems/live_video/face_recognition.py`, `face_embedder.py`, `face_service.py` | Hard | Foundational for presence awareness. None in core. |
| 6 | **Face registration with quality gating** | `app/subsystems/live_video/face_quality.py`, `face_cpu_detector.py` | Hard | Multi-mode (close/far), Laplacian sharpness, pose bounds, vector averaging. |
| 7 | **Ambient context assembly** | `app/subsystems/memory/ambient.py` | Moderate | Time-of-day, calendar, holidays, time-since-last-chat, weather — injected into synthesis without extra decomposer call. |
| 8 | **Memory disambiguation ("Which Artie?")** | `app/subsystems/memory/records.py` | Hard | Score candidates by relationship hint + recency, surface picker. Real household need. |

### Tier 2 — Refinements to Existing Core Systems

| # | Feature | Source | Difficulty |
|---|---|---|---|
| 9 | Decontextualize-query + memory rerank | `app/subsystems/memory/store.py` | Moderate |
| 10 | Tiered prompt-layer compilation (safety → policy → persona → prefs) | `app/subsystems/character/models.py`, `service.py` | Trivial |
| 11 | Care profiles (behavior presets like "Calm & Simple") | `app/subsystems/character/care.py` | Trivial |
| 12 | Fact lifecycle states (active/ambiguous/pending/rejected/superseded) + EMA confidence + recency decay | `app/subsystems/memory/records.py`, `db.py` | Moderate |
| 13 | LLM fact extraction with importance scoring & admin-review queue | `app/subsystems/memory/extract.py` | Moderate |
| 14 | Provider manager / profile-aware switching | `app/providers/manager.py`, `registry.py` | Moderate |
| 15 | Motion-gated detection (MOG2) — skip detector when scene is static | `app/subsystems/live_video/motion_gate.py` | Trivial |

### Tier 3 — UI Patterns to Adopt

| # | Feature | Source |
|---|---|---|
| 16 | Memory management panel (search, status filter, inline edit) | `app/ui/src/components/memory-management-panel.tsx` |
| 17 | Person registration panel with live preview + quality feedback | `app/ui/src/components/person-registration-panel.tsx` |
| 18 | Live camera preview with bounding boxes | `app/ui/src/components/live-camera-preview.tsx` |
| 19 | Audio waveform visualizer during STT | `app/ui/src/components/chat-audio-visualizer.tsx` |
| 20 | Browser-side barge-in / VAD interrupt | `app/ui/src/barge-in.ts` |
| 21 | Project editor + move-to-project modal | `app/ui/src/components/project-editor-panel.tsx` |
| 22 | Live execution timeline (decomposition → skills → synthesis with latency) | design doc §4 |

### Tier 4 — Phase-2+ / Optional

- Hailo acceleration providers (`app/providers/hailo*.py`) — hardware-conditional, fall back gracefully on plain Pi.
- Skill marketplace / installer / repository (`app/skills/repository.py`, `installer.py`).
- Animated character rendering with phoneme-aligned lipsync (`app/subsystems/character/render.py`).
- Runtime metrics dashboard (`app/metrics/*`) — CPU/RAM/GPU/latency.

---

## Part 3 — Prioritized Action Plan

### Immediate (this week)
1. Replace 3 `confirm`/`alert` calls in `AdminPage.tsx` with `ConfirmDialog`.
2. Fix hardcoded timestamp in [lokidoki/api/routes/tests.py:56](lokidoki/api/routes/tests.py#L56).
3. Tighten subprocess target validation in [lokidoki/api/routes/tests.py:34-41](lokidoki/api/routes/tests.py#L34-L41) (allowlist).
4. Add `min_length`/`max_length` to `ResetPinRequest`.
5. Decide: wire up or delete `tests.py` route.

### Short-term (next sprint)
6. Refactor the four worst offenders for the 250-line rule: `decomposer_repair.py` (800), `api.ts` (671), `AdminPage.tsx` (561), `orchestrator.py` (503).
7. Tighten broad `except Exception` catches in auth + weather skills.
8. Move embeddings backfill out of `MemoryProvider.initialize()` into a background task.
9. Replace `MemoryProvider` monkey-patching with proper composition/mixins.
10. Add unit tests for admin routes and `decomposer_repair` spaCy helpers.

### Medium-term — Legacy Ports (in priority order)
11. **Voice stack**: Piper catalog + installer → Faster-Whisper streaming → push-to-talk workflow → wake-word.
12. **Ambient context** in synthesis prompt (low effort, big perceived-intelligence win).
13. **Tiered prompt-layer compilation** + **care profiles** for character system.
14. **Memory disambiguation** UI + scoring.
15. **Fact lifecycle states** (if not already present in current schema — verify first).

### Long-term — Phase 2+
16. **Live video / face recognition** subsystem (motion gate → CPU detector → ArcFace embeddings → registration UI).
17. **Hailo provider** with graceful CPU fallback.
18. **Live execution timeline** UI over the existing SSE pipeline events.
19. **Runtime metrics** dashboard.
20. **Skill marketplace / installer** (only if extensibility becomes a goal).

---

---

## Progress Log — 2026-04-08

### ✅ Completed this pass

**Sidebar cleanup & collapse**
- Removed Execution Timeline, Decomposition Log, and System Metrics blocks from `Sidebar.tsx`.
- Deleted now-orphaned components: `ExecutionTimeline.tsx`, `DecompositionPanel.tsx`, `StatusMetrics.tsx`.
- Added persistent collapse toggle. Collapsed mode renders a 64px icon-only rail (Ghost branding, Chat, Memory, New Chat, ProfileMenu). State persisted in `localStorage` (`ld-sidebar-collapsed`).
- `ProfileMenu` got a new `compact` prop for the rail (avatar-only trigger).

**CLAUDE.md standards violations — code-level fixes**
- Replaced all 3 `confirm()`/`alert()` calls in `AdminPage.tsx` with `ConfirmDialog` (delete person, reset memory confirm, reset memory result).
- Tightened `ResetPinRequest` in `lokidoki/api/routes/admin.py` with `Field(..., min_length=4, max_length=64)`.
- Replaced broad `except Exception` in `lokidoki/auth/passwords.py` with `(ValueError, TypeError)` (specific bcrypt failure modes).
- Replaced broad `except Exception` in `lokidoki/auth/tokens.py` with `(jwt.InvalidTokenError, KeyError, ValueError)`.

**Dead / wasteful code removal**
- Deleted `lokidoki/api/routes/tests.py` (orphaned route, hardcoded timestamp, weak subprocess validation).
- Removed import + `include_router` for it from `lokidoki/main.py`.
- Deleted orphaned `frontend/src/components/Tests/TestRunner.tsx` (referenced no live route).

**New skills (6 added — Tier 1 of the high-value batch)**
| skill_id | source | offline? | mechanism |
|---|---|---|---|
| `calculator` | AST safe-eval; supports `15% of 240`, `sqrt`, `pi`, unicode `×÷^` | yes | `safe_eval` |
| `unit_conversion` | length / weight / volume / time / temperature table | yes | `table_lookup` |
| `dictionary` | dictionaryapi.dev (free, no key) | no | `dictionaryapi_dev` |
| `news_rss` | Google News RSS — topic feeds + search fallback | no | `google_news_rss` |
| `recipe_mealdb` | TheMealDB free public API | no | `themealdb` |
| `jokes` | icanhazdadjoke (free, no key) | no | `icanhazdadjoke` |

All six wired into `lokidoki/core/skill_factory.py` and verified to import + instantiate cleanly.

**Tests added**
- `tests/unit/test_skill_calculator.py` — 9 tests covering arithmetic, percentages, functions, constants, unicode operators, division-by-zero, name-injection rejection, empty input, unknown mechanism. **All pass.**
- `tests/unit/test_skill_unit_conversion.py` — 6 tests covering length, weight, temperature, cross-category rejection, unknown unit, non-numeric input. **All pass.**
- Full unit suite: 453 pass / 9 fail (the 9 failures are **pre-existing**, not introduced by this pass — verified via `git stash` baseline run).

### 🟡 Deferred / in-flight

**Restyle settings/admin/dev to full Onyx look** — *not done in this pass.* This requires a component-level redesign:
- Inner left section-nav for the admin panel (Documents & Knowledge / Permissions / Organization-style grouping seen in the Onyx screenshots).
- Card-grid "Add Provider" / "Add Connector" patterns for skills + character catalog.
- Per-section icon + heading + subtitle header pattern.
- Suggested approach: introduce a shared `<AdminLayout>` with a `<SectionNav>` component, then split the current `AdminPage.tsx` (561 lines) into one component per section (Users, Characters, Logs, Admin Controls, Danger Zone, Memory Inspector). That refactor also closes the 250-line ceiling violation for this file. Same pattern for `SettingsPage.tsx` and `DevPage.tsx`.

**Tier-2 skills (next batch — pre-designed, not yet built)**
These are the "next 5–10" beyond the six just added:
- `timer` — countdown / alarm; needs persistent store + websocket fan-out for fire events.
- `reminders` — persistent reminders attached to user/person; reuses memory schema.
- `stocks_yahoo` — Yahoo Finance public quote endpoint (no key).
- `sports_espn` — ESPN's hidden public scoreboard endpoints (no key).
- `trivia_opentdb` — opentdb.com (free, no key).
- `package_tracking` — carrier-agnostic via `17track` or per-carrier scrapers (paid; mark as Tier 3).
- `traffic_directions` — OSRM public demo for routing; OpenStreetMap Nominatim for geocoding.
- `media_embeds` — pure formatter that recognizes YouTube / image / Wikipedia URLs in skill output and emits `media_metadata` for the frontend to render inline.
- `holidays` — local table (US federal + observances) and `date.nager.at` for international.
- `iss_passes` — Open Notify (free, no key) — fun ambient skill.

**Oversized files (CLAUDE.md 250-line ceiling)** — flagged in §1.1 above; not yet refactored. Top priorities for next pass: `decomposer_repair.py` (800), `api.ts` (671), `AdminPage.tsx` (561), `orchestrator.py` (503).

**Other still-open items from §1.2 / §1.3**:
- Hardcoded timestamp in `tests.py` — moot, file deleted.
- Weak subprocess validation in `tests.py` — moot, file deleted.
- N+1 admin fact reload — still open.
- Embeddings backfill blocking startup — still open.
- `MemoryProvider` monkey-patching — still open.

---

## Notes

- Before porting any "fact lifecycle" or "memory schema" feature, **verify current state of `memory_schema.py`** — much of it may already exist under different names.
- Before porting prompt-layer compilation, confirm whether `character_ops.py` already merges layered instructions; if so, this becomes a refinement rather than a new feature.
- All ported features must continue to honor the **"no regex/keyword classification of user intent"** rule — any new branching signals must come from the decomposer's structured output.
