# Chunk 2 — Lean v1 policy gate and interaction loop

## Goal

Wire device-originated events into a minimal policy and interaction gate
without pulling in the full long-term presence architecture.

## Files

Touch:

- `lokidoki/presence/state.py`
- `lokidoki/presence/loop.py`
- `lokidoki/presence/attention.py`
- `lokidoki/presence/privacy.py`
- `lokidoki/presence/interaction_policy.py`
- `tests/unit/test_presence_policy_gate.py`

Read-only:

- `docs/lokidoki-presence-enhancement-design.md`
- `docs/companion-device-master-service/DESIGN.md`

## Actions

1. Add presence-state structures for:
   - device interaction state
   - direct-address confidence
   - effective privacy mode
   - effective interaction policy
2. Add a conservative gate that decides whether a bot event may trigger:
   - no-op
   - cue
   - prompt to orchestrator
3. Respect the policy stack from the presence design:
   - interaction policy
4. Keep Lean v1 narrow:
   - no multi-person inference
   - no room occupancy model
   - no proactive routines
   - no camera-led attention logic
5. Add tests for:
   - `wake_word_only`
   - `do_not_interrupt`
   - quiet hours suppression
   - explicit direct-address allowance

## Verify

```bash
pytest tests/unit/test_presence_policy_gate.py
```

## Commit message

```text
feat(presence): add bot-aware policy gate
```
