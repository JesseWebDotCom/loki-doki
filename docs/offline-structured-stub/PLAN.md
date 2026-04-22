# Offline Structured Stub — Execution Plan

Goal: when the knowledge-skill fast-path fires in Auto mode (good ZIM hit, non-rich routing), emit a **structured** markdown stub — lead paragraph + first 2–3 `<h2>` sections with their opening paragraph — instead of the lead paragraph verbatim with no structure. Zero LLM engaged, still offline, still fast. Pi "who is X" queries stay snappy (avoiding the 10–30s synthesis cost) but look like the Rich/Deep path.

Rich/Deep modes still go through full LLM synthesis for conversational framing. This plan only changes Auto-mode fast-path output.

Related: [TODO.md §4](../../TODO.md).

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
6. **Stop.** Do not begin the next chunk in the same session.

**Scope rule**: only touch files listed in the chunk doc's `## Files` section.

---

## Status

| # | Chunk | Status | Commit |
|---|---|---|---|
| 1 | [`_LeadExtractor` captures per-section opening paragraphs](chunk-1-extractor-per-section.md) | done | 7be164564f6b9f015fe3d30a051cb80c2e8d3697 |
| 2 | [Knowledge skill composes structured markdown](chunk-2-knowledge-skill-markdown.md) | done | cca8c49105f588a1e2edc9fcd54a623ba8ea3e8f |
| 3 | [Auto-mode non-rich path renders stub without LLM](chunk-3-auto-mode-routing.md) | done | 9baaa00e0ae0647c032282dcfa786faeb00c84ed |
| 4 | [Tests — parser, Auto-mode fast-path, Rich/Deep unchanged](chunk-4-tests.md) | done | 9baaa00e0ae0647c032282dcfa786faeb00c84ed |

---

## Global context (read once, applies to every chunk)

### Hard rules (from CLAUDE.md — non-negotiable)

- **Offline-first runtime.** Wikipedia data comes from the local ZIM file; runtime does not reach out.
- **No regex/keyword classification of user intent.** Routing decisions already branch on decomposer fields (`response_mode`, `overall_reasoning_complexity`, etc.). Do not add a new regex heuristic here — use existing decomposer output.
- **Onyx Material + shadcn/ui only** for any UI added (this plan is mostly backend, minimal/no UI).
- **Test data mocking.** Never use real family / friend / personal names in tests. Use pop culture characters (Luke, Anakin, Leia, Padme) or generic placeholders.
- **Push rules.** Commit only.

### Code landmarks (verified against current tree)

| Concern | Path | Key symbols / lines |
|---|---|---|
| Wikipedia HTML parser | [`lokidoki/skills/knowledge/_parse.py`](../../lokidoki/skills/knowledge/_parse.py) | `_LeadExtractor` (L140), `parse_wiki_html` (L224), currently returns `(lead: str, sections: list[str])` — sections is flat list of H2 titles only, no per-section paragraphs |
| Knowledge skill | [`lokidoki/skills/knowledge/skill.py`](../../lokidoki/skills/knowledge/skill.py) | `parse_wiki_html` call (L261), `MechanismResult.data` shape (L267): `{title, lead, sections, url}` |
| Response mode derivation | `lokidoki/orchestrator/response/mode.py` | Auto / Rich / Deep selection |
| Synthesis fallback / direct-chat | `lokidoki/orchestrator/fallbacks/llm_prompt_builder.py` | `_is_direct_chat_only()` (L469), `_RICH_MODE_DIRECTIVE` (L496–503), `_derive_response_mode_for_prompt()` (L84–124) |
| Fast-lane | `lokidoki/orchestrator/pipeline/fast_lane.py` | `check_fast_lane()` returns `FastLaneResult` (L84–107); checked in `run_pre_parse_phase` (`pipeline_phases.py` L145) |
| Response envelope | `lokidoki/orchestrator/response/` | Summary block rendering, `spoken_text` derivation |

### Invariants to preserve

- **Rich/Deep paths unchanged.** Full LLM synthesis still runs for response_mode ∈ {rich, deep} — the structured stub only replaces the Auto-mode fast-path output.
- **Fast-lane short-circuits unchanged.** If `check_fast_lane` already matches for a non-knowledge query (calculator, time, etc.), don't reroute through the stub.
- **Existing `sections: list[str]` consumers.** Grep for downstream callers of `MechanismResult.data["sections"]` and update them to the new shape, or keep the field name stable and change the element type with a migration note.
- **`spoken_text` semantics.** If the stub replaces the summary, the `spoken_text` for TTS should still be the lead paragraph only (H2 sections are visual structure; speech reads them as a run-on).
- **Citation integrity.** The stub is single-source (one Wikipedia article via ZIM). The source chip still renders; `[src:N]` markers in the stub should remain consistent with the chunk-11 source surface.

### What success looks like

A user types "who is Ada Lovelace" on a Pi with the English ZIM installed, in Auto mode. Instead of the current lead paragraph verbatim, they get:

```
Augusta Ada King, Countess of Lovelace was an English mathematician and writer… [lead continues]

## Early life

Ada, as she was known, was born on 10 December 1815 as the only legitimate child of…

## Adult years

In early 1833, Ada had an affair with a tutor, beginning…

## Work on the Analytical Engine

In 1840, Babbage was invited to give a seminar at the University of Turin…
```

Total latency ≤ 500ms on mac, ≤ 1.5s on Pi (no LLM). Rich mode for the same query still routes through the LLM and produces a conversational response.

---

## NOTE

Append-only. Record cross-chunk discoveries or deferrals that change the plan.

- 2026-04-22: User explicitly overrode the one-chunk-at-a-time execution rule and requested the remaining chunks be implemented in one pass. Chunk 3 and chunk 4 were completed together in commit `9baaa00e0ae0647c032282dcfa786faeb00c84ed`.
