# Chunk 4 — Device gateway, render intents, and device UI surfaces

## Goal

Add the first end-to-end local bot transport path and the LokiDoki UI surfaces
needed to inspect and control it.

## Files

Touch:

- `lokidoki/device_gateway/server.py`
- `lokidoki/embodiment/types.py`
- `lokidoki/embodiment/device_renderer.py`
- `lokidoki/api/routes/devices.py`
- `frontend/src/components/devices/`
- `frontend/src/pages/ChatPage.tsx`
- `tests/unit/test_device_renderer.py`
- `frontend/src/components/devices/__tests__/DevicePanel.test.tsx`

Read-only:

- `docs/companion-device-master-service/DESIGN.md`

## Actions

1. Add a local bot WebSocket endpoint and registry.
2. Add embodiment output intents for:
   - face
   - subtitle
   - status
    - audio stop/play
3. Add a first device panel showing:
   - connected bots
   - capabilities
   - privacy state
   - interaction policy
   - recent device health
4. Keep all UI assets local and consistent with existing frontend patterns.
5. Do not include maps, cards, or rich media surfaces in Lean v1.

## Verify

```bash
pytest tests/unit/test_device_renderer.py && npm --prefix frontend run test -- DevicePanel && npm --prefix frontend run build
```

## Commit message

```text
feat(device-gateway): add local companion device gateway and panel
```
