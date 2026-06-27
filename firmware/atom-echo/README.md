# Atom Echo voice satellite (firmware)

ESPHome firmware that turns an **M5Stack Atom Echo** into a Loki Doki voice
satellite: it streams 16 kHz mic audio to the server's Wyoming gateway, plays the
companion's spoken reply, and lights its RGB LED to match the conversation. Wake
word runs **server-side** (the Echo just streams), so the screenless PICO stays
dumb.

```
firmware/atom-echo/
  atom-echo.yaml                         ESPHome device config (pins, audio, Wi-Fi/Improv)
  components/lokidoki_satellite/         custom external component (Wyoming TCP client)
    __init__.py                          ESPHome codegen + config schema
    lokidoki_satellite.h / .cpp          the runtime (socket, framing, audio, LED, token)
```

## How it talks to the server

A single TCP connection to the Loki Doki gateway (`POD_GATEWAY_PORT`, default
`10700`) speaking the same Wyoming framing as `backend/src/lib/pod/wyoming.ts`:

```
{"type":"audio-chunk","data_length":38,"payload_length":1024}\n
{"rate":16000,"width":2,"channels":1}<1024 bytes int16 PCM>
```

- **Up:** one `audio-start`, then continuous `audio-chunk`s of 16 kHz mono int16
  mic PCM (server-side openWakeWord gates capture).
- **Down:** `user-event{name:"face.state"}` → LED; `audio-start`/`audio-chunk`/
  `audio-stop` → speaker.
- **Identity:** unpaired → `user-event{name:"hello", hwid, model}`; the admin
  Claims it and the server pushes `user-event{name:"auth", token}`, which the
  device stores in NVS and replays on every future connect.

LED: faint white = idle, green = listening, blue = thinking, cyan = talking.

## You normally don't touch this directly

This is the **build template** the app compiles. Flashing is done from the app:
**Admin → Devices → "Add a device"** installs ESPHome (managed venv), bakes your
home Wi-Fi + the server address in, and flashes the Echo plugged into the
server's USB — see the in-app wizard (`FlashDeviceWizard.tsx`) and
`backend/src/lib/pod/firmware.ts`. The CLI below is only for manual debugging.

```bash
# what the app runs under the hood:
esphome -s wifi_ssid <SSID> -s wifi_password <PASS> \
        -s lokidoki_host <SERVER_IP> -s lokidoki_port 10700 \
        run atom-echo.yaml --device /dev/cu.usbserial-XXXX
```

## Onboarding (no typing)

1. **Flash** once from the app (USB into the server). Home Wi-Fi is baked in.
2. **Power on anywhere** → the Echo auto-joins Wi-Fi, connects to the gateway, and
   appears under **Admin → Devices → "Unclaimed devices nearby."**
3. **Claim** → assign a user + companion. Online immediately — no code to type.
4. **Test:** say the wake word → LED green → ask a question → the companion
   answers through the Echo, LED following idle→listening→thinking→talking.

To re-pair after a factory reset, just Claim it again — the server reuses the
device row by hardware id (no duplicate). Moving it to a different Wi-Fi network
falls back to Improv-over-Bluetooth provisioning.

## Build status

**Compiles clean** with `esphome compile` against **ESPHome 2026.6.2** (ESP32 /
classic Atom Echo) → produces `firmware.factory.bin`. Verified: the YAML config,
the custom external-component schema, and the C++ component all build with no
errors. **Not yet exercised:** the physical USB flash + on-air behavior
(wake → spoken reply), which needs the hardware in hand.

Note: the pin map targets the **classic Atom Echo (ESP32-PICO)**; the newer
**Atom Echo S3R** (ESP32-S3) is a different board + pin map and could run on-device
`micro_wake_word` instead of server-side wake.
