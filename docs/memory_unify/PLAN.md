# Memory Unification — Execution Plan

Goal: one SQLite file (`data/lokidoki.db`), one write path (gate-chain), one read path (unified reader), no `v2`/`V2`/`_v2_` markers in the codebase.

---

## How to use this document (Claude Code operating contract)

You are a fresh Claude Code session. You have been pointed at this file and given no other instructions.

**Do exactly this:**

1. Read the **Status** table below. Pick the **first** chunk whose status is `pending` — call it Chunk N.
2. Open `chunk-N-*.md` and read it completely. **Do not open any other chunk doc.**
3. Execute every step in its `## Actions` section.
4. Run the command in its `## Verify` section. If it fails, do not proceed — diagnose or record the block and stop. Do not fake success.
5. If verify passes:
   - Stage only the files the chunk touched.
   - Commit using the template in the chunk's `## Commit message` section. Follow `memory/feedback_no_push_without_explicit_ask.md` — **commit only; do not push, open a PR, or merge.**
   - Edit this `PLAN.md`: flip the chunk's row from `pending` to `done` and paste the commit SHA in the `Commit` column.
   - If during execution you discovered work that had to be pushed to a later chunk (e.g. a test failure that's out of scope, a renamed identifier you couldn't touch yet), append a `## Deferred from Chunk N` bullet list to that later chunk's doc with the specifics.
6. **Stop.** Do not begin the next chunk in the same session. Each chunk gets its own fresh context to keep token use minimal.

**If blocked** (verify keeps failing, required file is missing, intent of the chunk is unclear): leave the chunk status as `pending`, write a `## Blocker` section at the bottom of that chunk's doc explaining what's wrong, and stop. Do not guess.

**Naming rule**: no `v2` / `V2` / `_v2_` in any new name you introduce. Pydantic's `v2`, external URLs like `/api/v2/…`, and the model id `sentence-transformers/all-MiniLM-L6-v2` are legitimate and stay.

**Scope rule**: only touch files listed in the chunk doc's `## Files` section. If work sprawls beyond that list, stop and defer the sprawl to a later chunk rather than expanding this one.

---

## Status

| # | Chunk                                             | Status  | Commit  |
|---|---------------------------------------------------|---------|---------|
| 1 | [Nuke DBs + repoint default path](chunk-1-nuke-and-repoint.md)         | done    | fa5583b |
| 2 | [Union schemas](chunk-2-schema-union.md)                               | done    | f991fe3 |
| 3 | [Unified writer](chunk-3-unified-writer.md)                            | done    | PENDING |
| 4 | [Unified reader](chunk-4-unified-reader.md)                            | pending |         |
| 5 | [Collapse provider/store in pipeline context](chunk-5-collapse-context.md) | pending |         |
| 6 | [De-`v2` identifiers](chunk-6-rename-v2.md)                            | pending |         |
| 7 | [Delete dead code + doc sweep](chunk-7-dead-code-and-docs.md)          | pending |         |

---

## Global context (read once, applies to every chunk)

- There used to be two DBs: `data/memory.sqlite` (v2 memory subsystem) and `data/lokidoki.db` (legacy: auth, chat history, UI-facing facts/people). They write to different files, so v2 extractions never appear in the Memory UI.
- The legacy `lokidoki.db` owns tables the v2 system doesn't: `users`, `app_secrets`, `characters`, `voices`, `wakewords`, `chat_traces`, `messages`, `projects`, `skill_*`, `chat_traces`, etc. These stay.
- The v2 system owns `episodes`, `behavior_events`, `affect_window`, `user_profile`, plus augmentations to `facts`, `people`, `relationships`, `sessions`.
- **Target**: one DB file (`data/lokidoki.db`), both schemas coexist there. `MemoryStore` is the write surface for triple-shaped tiers; dedicated `pipeline_hooks` write session/episode/affect/behavior. `MemoryProvider` stays the async public face (chat/auth/projects) but its fact/people/relationship methods delegate to `MemoryStore` reads/writes.

Seven-tier reference: [docs/DESIGN.md §6](../DESIGN.md).
