# LokiDoki v2 Unified Implementation Plan

**Created:** 2026-04-12
**Status:** Active. Update after each chunk completes.
**Purpose:** Single source of truth for the v2 migration. Merges `v2-graduation-plan.md`, `MEMORY_DESIGN.md`, and `v2-skills-design.md` into one executable sequence optimized for Claude Code sessions.

---

## Token Budget Strategy

The three design docs total ~65K tokens. Reading all three per chat session is wasteful. Instead:

1. **This file** (~3K tokens) is the only doc every session reads. It has the dependency graph, chunk status, and pointer to the right briefing.
2. **Per-chunk briefings** (`docs/chunks/chunk-NN.md`, ~2-4K tokens each) contain *only* the extracted context needed for that chunk: relevant design sections, file paths, acceptance criteria, and what changed since the design was written.
3. **`docs/PROGRESS.md`** is the append-only log. Each chunk appends what it shipped and what the next chunk should know.

**Session protocol:** Read this file -> find the next incomplete chunk -> read that chunk's briefing + the last PROGRESS.md entry -> execute -> append to PROGRESS.md -> update this file's status table.

---

## What's Already Done

| Source | Section | Status |
|---|---|---|
| MEMORY_DESIGN | M0 Prerequisites | complete |
| MEMORY_DESIGN | M1 Write path (gate chain, Tier 4/5 writes) | complete |
| MEMORY_DESIGN | M2 Read path (Tier 4 retrieval, FTS5+RRF) | complete |
| MEMORY_DESIGN | M2.5 Vector embeddings (third RRF source) | complete |
| MEMORY_DESIGN | M3 Tier 5 social (people resolver, scoring) | complete |
| MEMORY_DESIGN | M3.5 Auto-merge (cross-turn handle promotion) | complete |
| MEMORY_DESIGN | Dev tools runtime memory wiring | complete |
| Graduation Plan | 4.A Memory write-side | complete (via M1) |
| Graduation Plan | 4.B Memory read-side | complete (via M2) |
| Graduation Plan | 4.D People resolution | complete (via M3) |
| Graduation Plan | 3.1 President bug | complete (via M1 Gate 1) |
| Graduation Plan | 3.2 People seed leak | complete (empty default) |
| Graduation Plan | 3.3 Router false-positives | complete (ROUTE_FLOOR=0.55) |

**Test count:** 1588 tests, 124 memory-specific (M0-M3.5).

---

## Chunk Execution Order

Chunks are ordered by dependency. Each chunk = one Claude Code chat session.

| Chunk | Title | Depends On | Briefing | Est. Size | Status |
|---|---|---|---|---|---|
| **C01** | Memory M4: session state + episodic + promotion | M0-M3.5 (done) | `chunks/chunk-01.md` | Large | **complete** |
| **C02** | Skills Foundation: contracts + registry cleanup | none | `chunks/chunk-02.md` | Large | **complete** |
| **C03** | Persona + Synthesis (graduation 4.F + 4.H) | none | `chunks/chunk-03.md` | Medium | **complete** |
| **C04** | SSE Streaming wrapper (graduation 4.J) | none | `chunks/chunk-04.md` | Medium | **complete** |
| **C05** | Prompts / Decomposer refinement (graduation 4.C) | none | `chunks/chunk-05.md` | Medium | **complete** |
| **C06** | Citations end-to-end (graduation 4.G) | C03 (persona/synthesis) | `chunks/chunk-06.md` | Small | **complete** |
| **C07** | Skills Runtime Wiring (skills phase 2) | C02 (foundation) | `chunks/chunk-07.md` | Large | **complete** |
| **C08** | Memory M5: procedural (Tier 7a/7b) | M2 (done) | `chunks/chunk-08.md` | Medium | **complete** |
| **C09** | Memory M6: affective (Tier 6, character overlay) | C03 (persona) | `chunks/chunk-09.md` | Medium | **complete** |
| **C10** | V1 Cutover: chat.py swap + v1 deletion | C01, C03, C04 | `chunks/chunk-10.md` | Medium | **complete** |
| **C11** | Skills Phase 3: finish v1 ports | C07 | `chunks/chunk-11.md` | Large | **complete** |
| **C12** | Skills Phase 4-8: providers + device + polish | C11 | `chunks/chunk-12.md` | Large | **complete** |
| **C13** | V1 Deletion + V2 Promotion (erase "v2" everywhere) | C10, C11 | `chunks/chunk-13.md` | Large | **complete** |
| **C14** | Refactor oversized code + full-spectrum E2E test suite | C13 | `chunks/chunk-14.md` | Large | **complete** |
| **C15** | Skills admin & settings pages: v2 registry rewire | C13 | `chunks/chunk-15.md` | Medium | not started |

### Dependency Graph

```
C01 (Memory M4) ──────────────────────┐
C02 (Skills Foundation) ─── C07 ──┐   │
C03 (Persona+Synthesis) ─── C06   │   │
C04 (SSE Streaming) ──────────────┼───┼── C10 (Cutover) ── C11 ── C12
C05 (Prompts/Decomposer) ─────────┘   │                      │
C08 (Memory M5) ──────────────────────┘                       │
C09 (Memory M6) ───────── needs C03                           │
                                                C13 (Promotion) ── needs C10 + C11
                                                  │
                                                C14 (Refactor + E2E) ── needs C13
                                                C15 (Skills Pages)   ── needs C13
```

**Critical path to cutover:** C01 + C03 + C04 + C10.
**Parallelizable:** C02, C03, C04, C05 are all independent. C08, C09 are independent of most chunks.

---

## Corrections & Improvements Found During Review

### MEMORY_DESIGN.md
1. **M4 has duplicated "Deliverables" section** (lines 846-859 repeat lines 848-859). Cosmetic — doesn't affect implementation. The TODO list at lines 826-843 is the authoritative pickup point.
2. **M4 clean-cutover is settled.** v2 uses its own `data/v2_memory.sqlite`. The original Section 7 wording about shared storage is superseded. The M4 TODO correctly references `V2MemoryStore` methods.
3. **Consolidation threshold of 3** may be too high for single-session UX. The design flags this as open question #11. Implement with 3 as default, make it a constant, bench later.

### v2-graduation-plan.md
4. **4.D (people resolution) is already complete** via Memory M3. The graduation plan doesn't reflect this. The gate checklist items are all green.
5. **4.A and 4.B are complete** via M1 and M2 respectively. Same: graduation plan doesn't reflect this.
6. **4.E (conversation context) maps directly to Memory M4.** The graduation plan treats them separately but they're the same work. C01 covers both.
7. **Section 6 critical path** says "4.D -> 4.A -> 4.B -> 4.J -> cutover" — but 4.D, 4.A, 4.B are all done. The real remaining critical path is: **M4 (C01) + Persona/Synthesis (C03) + SSE (C04) -> cutover (C10)**.

### v2-skills-design.md
8. **Skills Phase 2 duplicates work already done.** It calls for wiring `LokiPeopleDBAdapter` — already done in M3. It calls for replacing `ConversationMemoryAdapter` — that's M4 (C01). Skills Phase 2 should focus on: dynamic skill loader, typed params, source propagation, HA adapter swap. The chunk briefing reflects this.
9. **Phase 1 is large.** The briefing splits it into "must-do-now" (registry truthfulness, error taxonomy, drift CI) vs "can-defer" (full plugin discovery seam, which is post-cutover work).
10. **Phases 4-8 are post-cutover.** They improve provider quality but aren't needed for the v1 -> v2 switch. Grouped into C12 as a backlog.

### Cross-cutting
11. **Bake-off discipline is heavy for solo dev + Claude Code.** The designs call for 2+ approaches benched per subsystem. For subsystems where one approach is clearly dominant (e.g., deterministic consolidation), we'll implement the obvious winner, add the corpus and tests, and document why the bake-off was skipped. Real bake-offs reserved for genuinely ambiguous decisions.
12. **The three docs should NOT be modified during implementation** — they're historical design records. This plan and the chunk briefings are the living execution layer on top.

---

## How to Start a New Chat Session

```
1. Read docs/IMPLEMENTATION_PLAN.md (this file)
2. Find the first chunk with status "not started" or "in progress"
3. Read docs/chunks/chunk-NN.md for that chunk
4. Read the last entry in docs/PROGRESS.md
5. Execute the chunk
6. Append results to docs/PROGRESS.md
7. Update this file's status table
8. Commit
```

If the chunk is too large for one session, the chunk briefing says where to split. Always update PROGRESS.md before ending.
