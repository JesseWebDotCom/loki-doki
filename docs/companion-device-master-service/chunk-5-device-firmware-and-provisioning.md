# Chunk 5 — Provisioning flow and companion-device firmware MVP

## Goal

Create a minimal companion-device firmware/client path that can pair locally, join Wi-Fi,
and exchange the first useful events with the master service.

## Files

Touch:

- `frontend/src/components/devices/SetupFlow.tsx`
- `lokidoki/api/routes/devices.py`
- `scripts/`
- `loki-doki-plugins` or external firmware repo notes if required by the repo split
- `docs/companion-device-master-service/DESIGN.md`

Read-only:

- `docs/companion-device-master-service/PLAN.md`

## Actions

1. Define the local pairing and provisioning contract.
2. Keep firmware/device-specific code outside the core repo when that better
   preserves the three-repo split.
3. Support:
   - device discovery
   - device key exchange
   - Wi-Fi provisioning or recovery
   - first heartbeat / hello event
4. Keep the firmware MVP narrow:
   - connect
   - stream mic chunks
   - render state/subtitles
   - accept privacy and stop commands
5. Document any firmware-repo boundary explicitly.

## Verify

```bash
echo "manual/hardware-assisted verification required for provisioning flow"
```

## Commit message

```text
feat(device-gateway): add local provisioning MVP
```
