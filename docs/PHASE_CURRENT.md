# LokiDoki — Current Phase

**Active Phase: 9 — Persona System**

Update this file when a phase gate passes. Agents read only this file for phase context — not the full phase list.

---

## Phase 8 Gate Result

Phase 8 passed on April 3, 2026.

- [x] Session-scoped memory persists for the active conversation only
- [x] Person-scoped memory stores and retrieves cross-session facts for the correct linked person/user
- [x] Family/shared memory stores and retrieves household context independently of person memory
- [x] Memory reads and writes are exposed through the application API with clear scope selection
- [x] Memory data does not bleed across session, person, and family scopes
- [x] Memory persistence remains SQLite-first and prepares writes for async replication via `memory_sync_queue`
- [x] **Advanced:** Implemented Hybrid Search (Vector Similarity + FTS5 BM25) for high-precision retrieval
- [x] **Advanced:** Implemented "Intelligence Queue" (Purgatory) for LLM-driven fact extraction and auto-promotion

---

## Phase 5 Gate Result

Phase 5 passed on March 26, 2026.

- [x] Push-to-talk captures speech, transcribes it, and sends it through the chat pipeline
- [x] TTS speaks the assistant response
- [x] Wake word -> STT transcribes -> LLM responds -> TTS speaks
- [x] Voice registry persists and loads correctly
- [x] Barge-in detected and handled cleanly on `mac`

Pi validation is deferred. Advance was approved based on current `mac` behavior and local testing.

---

## Phase 6 Gate Result

Phase 6 passed on March 26, 2026.

- [x] Profile switching changes detector provider selection with no code changes
- [x] `mac` object detection returns detections through the shared schema
- [x] `pi_cpu` object detection returns detections through the shared schema
- [x] `pi_hailo` object detection prefers HEF, falls back cleanly when unavailable, and never crashes
- [x] Live detection wiring remains profile-driven rather than branch-driven

Pi live validation is deferred. Advance was approved based on current `mac` behavior, repo tests, and Pi fallback verification.

---

## Phase 7 Gate Result

Phase 7 passed on March 26, 2026.

- [x] Profile switching changes face detector provider selection with no code changes
- [x] `mac` face detection returns detections through the shared schema
- [x] `pi_cpu` face detection returns detections through the shared schema
- [x] `pi_hailo` face detection prefers HEF, falls back cleanly when unavailable, and never crashes
- [x] Live face detection wiring remains profile-driven rather than branch-driven
- [x] Face embeddings and cosine identity matching are wired through the shared detection pipeline
- [x] The `Register a Person` UI captures good frames automatically and manages the flat-file registry

Advance was approved based on current `mac` behavior and a green repo test suite in the project virtualenv (`141 passed`).

---

## What to Build This Phase

- Session memory scoped to the current conversation
- Person memory for cross-session facts tied to recognized people and local users
- Family/shared memory for household-level context
- SQLite-backed memory persistence with `memory_sync_queue` support
- Local-first memory writes with async replication hooks for future master/client mode
- API wiring for memory read/write flows without leaking data across scopes

## What NOT to Build This Phase

- Persona runtime work (Phase 9)
- Plugins (Phase 10)
- systemd/launchd setup (Phase 12)
- Home Assistant and presence automation (Phase 11)
- Router hardening beyond what is needed to support current Phase 8 work

---

## Gate Checklist

Do not advance to Phase 9 until every item passes.

- [ ] Session-scoped memory persists for the active conversation only
- [ ] Person-scoped memory stores and retrieves cross-session facts for the correct linked person/user
- [ ] Family/shared memory stores and retrieves household context independently of person memory
- [ ] Memory reads and writes are exposed through the application API with clear scope selection
- [ ] Memory data does not bleed across session, person, and family scopes
- [ ] Memory persistence remains SQLite-first and prepares writes for async replication via `memory_sync_queue`

---

## Notes for This Phase

- Keep all behavior profile-driven: `mac`, `pi_cpu`, `pi_hailo`
- Memory is intentionally downstream of object detection and people identity
- Memory scopes are `session`, `person`, and `family/shared`
- Every node should remain SQLite-first, with local writes before any future replication
- Replication behavior should queue offline writes in `memory_sync_queue` and use last-writer-wins by timestamp
- Do not collapse people identity into auth users when storing person memory
- Heuristic web-query routing is still transitional; a later phase should replace patch-style factual web handling with structured routing, query rewriting, and deterministic extraction
- Preserve the bootstrap installer as plain HTML/CSS/JS

---

## Deferred Work (To be built in a later phase)

- **Performance Profiles Admin UI:** The chat composer and backend API (media/text endpoints) are fully piped to support "Fast", "Thinking", and "Pro" tokens via `performance_profile_id` -> `force_smart`. However, scaffolding the SQLite schema and React Settings UI required to tweak models inside these profiles on-the-fly was deferred. We must return to this during Phase 12 (Polish).

---

## Phase Sequence (Reference Only)

| Phase | Focus |
|---|---|
| 1 | Bootstrap + run.py + React skeleton + auth |
| 2 | Profile system + Hailo spike |
| 3 | Text subsystem (real LLM) |
| 4 | Image + video subsystems |
| 5 | Voice subsystem |
| 6 | Object detection (`mac`: YOLO11s, `pi_cpu`: YOLO11n, `pi_hailo`: YOLO11s HEF with YOLO11n fallback) |
| 7 | Face detection + people identity (`mac`: `yolov5s_personface.onnx`, `pi_cpu`: SCRFD-500M, `pi_hailo`: `yolov5s_personface.hef`, ArcFace-compatible embeddings on all profiles) |
| 8 | Memory subsystem |
| **9** | **Persona system** ← current |
| 10 | Plugin system + master/client node |
| 11 | Home Assistant + presence automation |
| 12 | Pi hardening + services + polish |
