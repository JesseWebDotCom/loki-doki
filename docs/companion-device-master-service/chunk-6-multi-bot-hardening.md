# Chunk 6 — Multi-bot arbitration, privacy hardening, and soak tests

## Goal

Make the embodied system safe, predictable, and stable when more than one bot
is active.

## Files

Touch:

- `lokidoki/device_gateway/arbitration.py`
- `lokidoki/presence/cooldowns.py`
- `lokidoki/presence/social.py`
- `lokidoki/presence/participants.py`
- `tests/unit/test_multi_bot_arbitration.py`
- `tests/integration/test_companion_device_master_service.py`

Read-only:

- `docs/lokidoki-presence-enhancement-design.md`
- `docs/companion-device-master-service/DESIGN.md`

## Actions

1. Add room-level arbitration so only the right bot responds.
2. Add anti-chatter cooldowns and handoff behavior between bots.
3. Add privacy hardening:
   - visible muted states
   - camera disable enforcement
   - policy explanation surfaces
4. Add integration coverage for reconnects, interrupted sessions, and
   multi-bot contention.

## Verify

```bash
pytest tests/unit/test_multi_bot_arbitration.py tests/integration/test_companion_device_master_service.py
```

## Commit message

```text
feat(device-gateway): harden multi-device local master service
```
