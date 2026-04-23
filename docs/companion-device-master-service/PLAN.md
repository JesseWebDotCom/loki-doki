# Companion Device Master Service — Execution Plan

Goal: add embodied companion-device clients to LokiDoki without breaking the
project's local-first, offline-first, skills-first architecture. When this plan
is complete, LokiDoki can act as a local master service for one or more
companion devices, with presence-aware behavior, inspectable privacy controls, and a
persona-pack system that builds on the existing character and memory model.

This plan is split into:

- Lean v1: one device, explicit interaction, minimal policy integration
- Platform later: richer presence, persona packs, and multi-device behavior

Read [`DESIGN.md`](./DESIGN.md) once per session. That is the design; this
directory is the execution plan.

---

## How to use this document

You are a fresh session working from this plan.

1. Read the **Status** table below.
2. Pick the first chunk whose status is `pending`.
3. Read only that chunk doc completely.
4. Execute its `## Actions`.
5. Run its `## Verify` command exactly.
6. If verify passes:
   - stage only the files listed in that chunk
   - commit only that chunk's work
   - update this `PLAN.md` row to `done` and add the commit SHA
7. Stop after that chunk.

If blocked:

- leave the chunk `pending`
- add a `## Blocker` section to that chunk
- stop without guessing

Scope rule:

- only touch files listed in the chosen chunk's `## Files` section

---

## Status

### Lean v1

| # | Chunk | Status | Commit |
|---|---|---|---|
| 1 | [Device gateway contracts and capability schema](chunk-1-device-contract.md) | pending | |
| 2 | [Lean v1 policy gate and interaction loop](chunk-2-presence-runtime.md) | pending | |
| 3 | [Device gateway, render intents, and device UI surfaces](chunk-4-device-gateway-and-ui.md) | pending | |
| 4 | [Provisioning flow and companion-device firmware MVP](chunk-5-device-firmware-and-provisioning.md) | pending | |

### Platform later

| # | Chunk | Status | Commit |
|---|---|---|---|
| 5 | [Persona packs on top of character/workspace systems](chunk-3-persona-pack-upgrade.md) | pending | |
| 6 | [Multi-bot arbitration, privacy hardening, and soak tests](chunk-6-multi-bot-hardening.md) | pending | |

---

## Global constraints

- Local-only inference, STT, TTS, wake word, and policy evaluation
- No Docker dependency
- Use `run.sh` / `run.bat` only
- Preserve platform profiles: `mac`, `pi_cpu`, `pi_hailo`
- Hailo remains optional and only for supported LLM/vision paths
- Every device path must degrade gracefully to screen-only LokiDoki
- Durable memory stays in SQLite, not markdown persona files
- Presence and privacy behavior must remain inspectable
- Lean v1 must stay explicitly smaller than the full platform vision

## NOTE

Append-only. Record deferrals, discoveries, or blockers here as later chunks
land.
