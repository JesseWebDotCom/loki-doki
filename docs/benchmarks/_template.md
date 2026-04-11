# v2 Memory Bake-off — {Phase} — {YYYY-MM-DD}

> Template for the per-phase bake-off docs required by [docs/MEMORY_DESIGN.md](../MEMORY_DESIGN.md) §8 and the [v2-graduation-plan](../v2-graduation-plan.md) §1 discipline. Copy this file to `docs/benchmarks/v2-memory-{phase}-bakeoff-{YYYY-MM-DD}.md` when starting a phase.

**Status:** draft | in-review | accepted
**Phase:** M0 | M1 | M2 | M3 | M4 | M5 | M6
**Owner:** {name or handle}
**Date opened:** {YYYY-MM-DD}
**Date accepted:** {YYYY-MM-DD or n/a}

---

## 1. What we're choosing

One paragraph. What is the decision this bake-off resolves? Which §X of the design doc requires it? Which §10 open question (if any) does it close?

---

## 2. Candidates

For each candidate include:

### Candidate A — {short name}

- **What it is:** one sentence
- **Where it lives:** file path(s) or external dependency
- **Cost shape:** latency profile, memory footprint, model size, dependency surface
- **Risk:** what could go wrong with this choice

### Candidate B — {short name}
…

---

## 3. Corpus

- **Corpus file(s):** `tests/fixtures/v2_memory_*.json`
- **Number of cases:** N
- **Slice breakdown:**
  - should-write: N
  - should-not-write: N
  - ambiguous: N
  - regression rows: N (including the president bug)

---

## 4. Metrics

| Metric | Target | Why this target |
|---|---|---|
| Precision (should-not bucket) | ≥ 0.98 | The president bug. False writes pollute durable storage. |
| Recall (should-write bucket) | ≥ 0.70 | False denies make the system feel "weirdly forgetful." |
| p95 added latency | < 50ms (gate chain) / < 250ms (with model) | Pi 5 budget |
| Cross-user isolation | 100% | Hard rule |

---

## 5. Results

| Candidate | Precision | Recall | p95 latency | Cross-user | Notes |
|---|---|---|---|---|---|
| A | | | | | |
| B | | | | | |

---

## 6. Decision

One paragraph. Which candidate ships? What does the loser tell us about future tuning?

---

## 7. Follow-ups

- [ ] Update `docs/MEMORY_DESIGN.md` §10 with any open question this bake-off closes.
- [ ] Update `docs/v2-graduation-plan.md` phase status if the corresponding gate is green.
- [ ] Add any new regression rows to `tests/fixtures/v2_regression_prompts.json`.
- [ ] Land the chosen implementation behind the feature flag from §8.

---

## 8. Lineage

- Predecessor bake-off (if any): `docs/benchmarks/...`
- Related design docs: [MEMORY_DESIGN.md](../MEMORY_DESIGN.md), [v2-graduation-plan.md](../v2-graduation-plan.md), [spec.md](../spec.md)
- External research consulted (Mem0, Hindsight, Pieces, MemPalace, etc.)
