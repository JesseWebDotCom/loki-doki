# M5Stack Tab5 voice satellite (firmware)

ESPHome firmware that turns an **M5Stack Tab5** (5" ESP32-P4 tablet) into a Loki
Doki voice satellite: it streams 16 kHz mic audio to the server's Wyoming gateway,
plays the companion's spoken reply, and lights its screen. Wake word runs
**server-side** (the Tab5 just streams), same as the Atom Echo.

```
firmware/tab5/
  tab5.yaml                 ESPHome device config (board, audio, display, Wi-Fi/Improv)
firmware/components/
  maipai_satellite/       SHARED custom component (Wyoming TCP client) — used by every device
```

## Hardware definition is copied verbatim from upstream

The Tab5 is an ESP32-P4 with an ESP32-C6 Wi-Fi co-processor (over SDIO), ES7210 mic
ADC + ES8388 speaker DAC, a 1280×720 MIPI-DSI panel with GT911 touch, two PI4IOE
I/O expanders for power/reset, an RX8130 RTC and an INA226 battery gauge. Getting
any of that wrong bricks the bring-up, so the hardware half of `tab5.yaml` is copied
**verbatim** from the official ESPHome device config:

- https://devices.esphome.io/devices/m5stack-tab5/
- https://github.com/esphome/devices.esphome.io/blob/main/src/docs/devices/M5Stack-Tab5/config.yaml

**Do not "tune" the pins/codec/expander values** — they're the known-good upstream
map. What we change vs. upstream is only the *pipeline*: where Home Assistant's
`voice_assistant` + `micro_wake_word` + `media_player` would go, we use our own
`maipai_satellite` component (server-side wake, our Wyoming framing) — exactly how
`firmware/atom-echo/atom-echo.yaml` does it.

Two deliberate deviations for our pipeline:

- **Speaker sample rate is 16 kHz** (upstream is 48 kHz), because the satellite
  streams raw 16 kHz mono int16 PCM down and does not resample.
- **DAC output is forced to `LINE1` on boot** (the onboard speaker amp). Upstream
  leaves that as a manual select; we set it automatically so audio works out of the
  box. `speaker_enable` restores `ALWAYS_ON` for the same reason.

The display currently shows ESPHome's test card on first boot (proves the panel,
touch and backlight are wired right). Rendering the companion's face/visemes on the
screen is the planned next step.

## How it talks to the server

Identical to the Atom Echo — a single TCP connection to the MaiPai Home gateway
(`POD_GATEWAY_PORT`, default `10700`) speaking the Wyoming framing in
`backend/src/lib/pod/wyoming.ts`. Up: `audio-start` then continuous `audio-chunk`s
of 16 kHz mono int16 PCM (server-side openWakeWord gates capture). Down:
`audio-start`/`audio-chunk`/`audio-stop` → speaker; `user-event{face.state}` →
(future) on-screen state. Identity: unpaired → `hello{hwid, model:"tab5"}`; the
admin Claims it and the server pushes `auth{token}`, stored in NVS.

## You normally don't touch this directly

This is the **build template** the app compiles. Flashing is done from the app:
**Admin → Devices → "Add a device"** — pick **M5Stack Tab5**, plug it into the
server's USB, and the wizard bakes your home Wi-Fi + the server address in and
flashes it. See `FlashDeviceWizard.tsx` and `backend/src/lib/pod/firmware.ts`
(model registry). The CLI below is only for manual debugging:

```bash
# what the app runs under the hood:
esphome -s wifi_ssid <SSID> -s wifi_password <PASS> \
        -s maipai_host <SERVER_IP> -s maipai_port 10700 \
        run tab5.yaml --device /dev/cu.usbserial-XXXX
```

> First flash downloads the **ESP32-P4** PlatformIO toolchain (a different toolchain
> from the ESP32-classic one the install step warms), so the very first Tab5 build
> takes a few extra minutes.

## Onboarding (no typing)

1. **Flash** once from the app (USB into the server). Home Wi-Fi is baked in.
2. **Power on** → the Tab5 auto-joins Wi-Fi, connects to the gateway, and appears
   under **Admin → Devices → "Ready to set up."**
3. **Claim** → assign a user + companion. Online immediately — no code to type.
4. **Test:** say the wake word → ask a question → the companion answers through the
   Tab5's speaker.

## Pre-rev3 (ECO) silicon — `engineering_sample: true`

Our unit is a pre-rev3 **ECO2** P4 (ROM reports `esp32p4-eco2`; the chip self-reports
`rev1.3`). A firmware built for the default production rev3 throws **"Illegal
instruction" at boot** on this silicon and watchdog-loops forever (never reaching
Wi-Fi). ESPHome's own build guidance for a pre-rev3 board is `esp32:
engineering_sample: true`, which targets the correct revision and caps the CPU at
360 MHz (400 MHz is engineering-sample-unsafe). That flag is set in `tab5.yaml`.
**Remove it for production (rev3+) Tab5s** — and note that toggling it forces a full
ESP-IDF rebuild (the chip-rev change rewrites sdkconfig).

## Build status

**Compiles + boots on real hardware.** Built with `esphome compile`/`run` against
**ESPHome 2026.6.2** (ESP32-P4 rev1.3, ESP-IDF 5.5.4) → `firmware.factory.bin`. On
the device: clean boot, `setup() finished successfully`, the `maipai_satellite`
component runs, and it attempts Wi-Fi association (verified with a placeholder SSID).
Known non-fatal boot warnings to revisit: the **GT911 touchscreen** reports
`Communication failed` (secondary — for the screen milestone), and the **RX8130 RTC**
logs `Invalid RTC time` until set. **Not yet exercised:** full on-air behavior
(join real Wi-Fi → Claim → wake → spoken reply).
