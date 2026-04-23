# Chunk 1 — Device gateway contracts and capability schema

## Goal

Create the backend contracts for local bot connections before any transport or
UI work starts.

## Files

Touch:

- `lokidoki/device_gateway/types.py`
- `lokidoki/device_gateway/protocol.py`
- `tests/unit/test_device_gateway_protocol.py`

Read-only:

- `docs/companion-device-master-service/DESIGN.md`

## Actions

1. Add typed dataclasses or Pydantic models for:
   - bot identity
   - capability advertisement
   - upstream events
   - downstream commands
2. Add a versioned protocol module with:
   - event type enums
   - validation helpers
   - compatibility guards
3. Keep transport-neutral contracts. No WebSocket server code in this chunk.
4. Cover the schema with unit tests for:
   - valid capability sets
   - unknown event rejection
   - backward-compatible optional fields

## Verify

```bash
pytest tests/unit/test_device_gateway_protocol.py
```

## Commit message

```text
feat(device-gateway): add local bot protocol contracts
```
