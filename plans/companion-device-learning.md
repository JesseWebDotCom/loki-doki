# Companion Device Learning: Answer Write-Back & Passive Procedural Capture

**Date:** 2026-07-16
**Status:** PLANNED (Phase 0 shipped; Phases 1 and 2 not started)
**Scope:** make conversational chat about Home Inventory devices *update* stored knowledge, not just read it, so repeat questions get grounded answers and casually stated facts stop evaporating.
**Origin:** review of the chat write-back paths (2026-07-16). Findings: the `remember` tool reliably captures explicit "note that..." facts into Notes; the passive memory judge never routes procedural facts to Notes; nothing ever persists a companion answer.

---

## Context: what exists today

| Flow | Persisted? | Where |
|---|---|---|
| "note that the XR resets by holding xyz" | yes | Note (append or create), embedded for recall; **now also linked to the device** (Phase 0) |
| Same fact said casually, no capture phrase | unreliable | `memories` table only, via the idle-sweep judge; never Notes, never the device sheet |
| Companion's generated answer to "how do I..." | never | nothing writes back (`routes/home.ts` `/ask`, `tools/homeInventory.ts` are read-only) |

### Phase 0 (SHIPPED 2026-07-16): device-link companion-captured notes

`tools/memory.ts`: when `classifyCapture` returns `note`, `findDeviceTarget(fact)` scores the fact against `home_devices` (conservative token overlap; model/name substring counts double; score below 2 or a tie links nothing) and `ensureDeviceLink` writes the `note_links` row (`targetType: 'device'`, idempotent). The device sheet's Notes tab (`GET /api/notes/by-target/device/:id`) now accumulates captured device knowledge. Verified 7/7 against the real device names (arcade pre-orders).

---

## Phase 1: teach the passive judge to route procedural facts to Notes (#3)

**Problem.** "Oh, you have to hold the xyz button to reset it," said mid-conversation without a capture phrase, is only seen by the memory judge (`memory/judge.ts`), whose extraction schema targets personal facts (person/place/preference/state...). Procedural device knowledge is either squeezed into a generic `fact` memory or discarded as one-off chatter.

**Design.**
1. Add a `procedural` signal to Phase-1 extraction: extend the judge's extraction prompt so each candidate fact also gets `kind: 'personal' | 'procedural'`. Personal facts flow through the existing ADD/UPDATE/DELETE dedupe path unchanged.
2. Route `procedural` facts through the exact pipeline the `remember` tool already uses: `findAppendTarget` (append vs create), `findDeviceTarget` + `ensureDeviceLink` (device linking), `createNote`/`appendToNote`. Extract these from `tools/memory.ts` into a shared `lib/notes/capture.ts` helper so the two callers cannot diverge (the "three diverged copies of the same brain" lesson from the architecture review).
3. Dedupe before writing: cosine the fact against existing `note_chunks` for the target note; at/above ~0.88 (mirror `DUPLICATE_COSINE`) skip silently. The judge runs on every idle sweep, so without this the same session would re-append the same fact.
4. Attribution: notes created by the judge get `source: 'companion'` and the same personal-ownership rule (owner = the speaking user; household sharing stays a deliberate UI action).

**Risks / mitigations.**
- Over-capture (noise notes from idle chatter): keep the judge's existing importance gate as a floor, and only route `procedural` facts that name a concrete subject (non-empty title from classification). Start conservative; loosen later.
- Judge prompt regression: extraction is the fragile step (a Phase-1 failure already halts cursor advance). Add the `kind` field as *optional* in the parse so a model that omits it degrades to `personal`, i.e. exactly today's behavior.

**Touchpoints:** `memory/judge.ts` (prompt + types + routing), new `lib/notes/capture.ts`, `tools/memory.ts` (refactor to use the shared helper), no schema changes.

**Test plan:** unit-drive the shared capture helper against a scratch DB (same harness as Phase 0); judge-level test with a canned conversation span containing one personal fact + one procedural fact, assert one memory row + one device-linked note.

---

## Phase 2: learned-answers write-back (#2)

**Problem.** When the companion answers a device question, the answer evaporates. If it reasoned from scattered context (or a future web/search tool), the next identical question starts from zero.

**Design: stage, don't auto-write.** Feeding generated answers back as ground truth is a hallucination-amplification loop, so answers are never silently persisted. Instead:

1. **Provenance gate.** Only answers grounded in a retrieved source qualify: the `home_inventory` tool returned a `manualText` excerpt, a device file, or a note chunk that the answer demonstrably drew from. Pure-LLM answers (no source hit) never qualify.
2. **Distill, then stage.** After a qualifying turn, a fast-model call distills the exchange to one imperative line ("Firmware update: hold Service + Reset 10 s, then flash via USB"). Stage it through the existing `stageWithDirective` confirm flow (same UX as the `forget` tool): the companion replies with the answer plus "Want me to save that to the Arcade2TV-XR's notes?" with approve/decline buttons.
3. **On approve:** write via the shared `lib/notes/capture.ts` from Phase 1 (append to the device-linked note or create one, dedupe at 0.88, link the device). The saved line carries a `(from manual, saved Jul 16 2026)` provenance suffix.
4. **Repeat-question payoff:** nothing new needed at read time; the saved note line is recalled by the existing passive notes injection and by the `home_inventory` tool's device sheet.

**Explicitly out of scope:** writing to `manualText` (that column is the fetched manual, keep it pristine); caching raw Q&A verbatim (distilled facts only); auto-save without user approval (revisit only after Phase 2 has run for a while and the approve rate is observed to be near-100%).

**Risks / mitigations.**
- Wrong distillation saved: the approve step shows the exact line to be saved; decline is one tap.
- Prompt-money cost: one extra fast-model call per *qualifying* device turn only.
- Confirm fatigue: rate-limit staging to once per device per conversation.

**Touchpoints:** `lib/companionTurn.ts` (post-turn hook where the tool result and final answer are both in hand), `lib/notes/capture.ts`, `stageWithDirective` (exists), no schema changes.

**Test plan:** turn-level integration test with a mocked Ollama: device question + manual hit stages a save; device question with no source hit stages nothing; approve writes the note and links the device; second identical save attempt dedupes.

---

## Sequencing

Phase 1 before Phase 2 (Phase 2 depends on the shared capture helper and its dedupe). Each phase lands independently on `main` with its own tests; neither requires a migration.
