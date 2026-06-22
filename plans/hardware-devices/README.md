# Loki Doki — Physical Device Hardware Proposals

Status: **proposal / not yet built** · Last updated: 2026-06-22

## Goal

Give Loki Doki physical presence in the home with off-the-shelf hardware that
replaces the Amazon Echo Dot, Echo Show, and adds two wearable/portable
camera-equipped form factors. Each device is a **Pod** in the existing
architecture (see `docs/lokidoki-speed-memory-family-design.md` in the v2
design notes): a "dumb" ESP32-class node that does cheap on-device gatekeeping
(wake word + VAD) and streams to a **Host** (a real computer running the LLM,
STT, TTS, and memory). The Host pushes audio and screen frames back to the Pod.

**Hard constraint for this round:** prefer devices that **ship in a finished
enclosure** — no 3D-printed cases. Where a board is bare, an off-the-shelf
case (or print-service shell) is named explicitly.

## Requirements

### Shared (all four devices)

| Requirement | How it's met |
| --- | --- |
| Wake word, on-device | openWakeWord TFLite-Micro on the ESP32-S3 (per Pod spec) |
| Audio responses | I2S speaker; Host streams PCM back to the Pod (`0x20` frames) |
| Wireless | 2.4 GHz Wi-Fi + BLE 5 (BLE used for provisioning) |
| **Unprompted responses (alarms, timers, notifications)** | See "Unprompted-response mechanism" below |
| Provisioning / OTA | BLE GATT setup + OTA model/firmware updates |

### Screened devices (Show + both watches)

- Capacitive touchscreen
- On-screen data display (clock, weather, timers, alarms, companion face) via LVGL
- Host pushes display/viseme frames (`0x21`)

### Camera ("vision") devices (both watches)

- Onboard camera for presence detection and image capture/attach to companion

### Power

- Dot, Show: mains-powered (USB-C)
- Both watches: onboard LiPo + charge circuit

## Unprompted-response mechanism (the tricky shared requirement)

Alarms/timers must fire even though the user didn't just speak.

- **Mains-powered Pods (Dot, Show):** hold a persistent WebSocket to the Host.
  Host fires the event → pushes audio + a screen frame. No battery concern.
- **Battery Pods (watches):** always-on Wi-Fi + always-listening drains a small
  cell fast. Use the **onboard RTC**: the Host syncs alarm/timer times to the
  RTC, which fires locally even if Wi-Fi is asleep or the Host is offline.
  Wi-Fi wakes on modem-sleep to re-sync.
- **Battery-life reality:** always-on wake word on a LiPo cell is *hours*, not
  days. For all-day wear, accept periodic-listen windows, a tap-to-wake
  (push-to-talk), or a low-power wake co-processor.

## Vision vs. all-in-one form factor (the core trade-off)

Camera + a cased *round-watch* shape **do not coexist** in off-the-shelf parts —
fully-cased camera devices bottom out around a 2" square body. So each screened
device is offered **two ways**:

- **With vision** — M5Stack Core-class (~2" square box, has camera). Accepts a
  boxy shape to keep the camera.
- **Without vision (all-in-one)** — a smaller / round / right-sized board that
  already ships cased, **needs no new case and no enlarging**, but has no camera.

Pick per device: use vision where presence/image-capture matters, use the
all-in-one where a clean round watch / compact puck matters more.

Cased-**camera** devices also have a **size gap**: M5Stack CoreS3 is 2", and the
next cased-camera device (Tab5) is 5" — nothing cased-with-camera exists in
between. The no-camera all-in-one boards fill the 1.28"–1.85" range that vision
can't reach.

---

## Proposals

### 1. Echo Dot replacement — speaker puck, no screen, always powered

**Pick: M5Stack Atom Echo** (or newer Atom VoiceS3R) — **~$13**, ships enclosed
(24×24×17 mm finished puck).

- Mic + speaker + RGB status LED (Echo-style light ring) in a sealed case, USB-C
- Reference ESPHome wake-word device ("Hey Jarvis"/"Okay Nabu") — de-risks wake word
- Mains-powered → persistent WS → trivial unprompted alarms

**Screen-bearing alternative:** Waveshare ESP32-S3-Touch-LCD-1.85C "Smart Speaker
Box" (~$30–40) — 1.85" round 360×360, dual mic, speaker, battery, in box form.
Adds a clock/alarm face.

*Sensors:* Atom Echo is audio-only; add a Grove ENV (temp/humidity) or PIR
presence module via the GROVE port if desired (solderless).

### 2. Echo Show replacement — large touchscreen, powered, camera

**Pick: M5Stack CoreS3** — **~$45**, ships enclosed with a DinBase mount.

- 2.0" glass capacitive touch (LVGL)
- **0.3 MP GC0308 camera** (presence / video / image attach)
- **Dual mic** (ES7210 codec), 1 W speaker (AW88298 I2S amp)
- 500 mAh battery + RTC
- **Bonus sensors already onboard:** LTR-553 ambient-light + proximity, BMI270 IMU
- DinBase enables wall / desk / screw mount out of the box

**Without vision (all-in-one, same case/size): M5Stack CoreS3 SE** (~$30) —
identical 2" cased body, mic + speaker + RTC, **no camera** (also drops proximity
and IMU). Drop-in if the Show doesn't need video/presence — cheaper, same
footprint, no new case.

**Bigger-screen alternative (cased):** Waveshare ESP32-S3-Touch-LCD-4.3 "Type B
with Case" (~$50) — 4.3" 800×480 IPS in an enclosure. **Caveat:** no onboard
mic/speaker; you'd add a USB/I2S mic+speaker, breaking the all-in-one cleanliness.

**Recommendation:** CoreS3 if the Show should keep the camera (video / presence);
CoreS3 SE if it's a display-only Show. Reserve the 4.3" SKU for when screen size
beats a clean audio path.

### 3. Apple-Watch-sized + battery — ~1.3–2" cased

**With vision — M5Stack CoreS3** (~$45), ships enclosed.
Camera + dual mic + speaker + 500 mAh battery + RTC + ambient-light/proximity +
IMU in a finished ~2" body. RTC backs offline alarms. Shape is a 2" square, not
a round watch.

**Without vision (all-in-one, true watch shape, no new case):**
- **Waveshare ESP32-S3-Touch-LCD-1.28-B** (~$30) — 1.28" round touch in a **CNC
  metal case**, mic + speaker, IMU, battery. The closest thing to an actual watch
  face; no camera.
- **LilyGO T-Watch S3** (~$40) — 1.54" cased smartwatch with strap, mic + speaker,
  400 mAh battery, RTC. Wearable out of the box; no camera.

**Recommendation:** if this device is mostly glanceable info + voice (clock,
timers, alarms, quick replies), the **1.28-B** or **T-Watch S3** is the better
all-in-one — round, smaller, already cased, no enlarging. Choose CoreS3 only if
this specific unit needs the camera.

### 4. Wider watch (minimally larger screen) + battery

**Without vision (all-in-one, minimally wider, already cased) — recommended:**
**Waveshare ESP32-S3-Touch-LCD-1.85C** (~$30–40) — 1.85" round 360×360 touch,
mic + speaker, battery, RTC, ships as a finished "Smart Speaker Box." This is the
true "minimally wider" step up from Scenario 3's 1.28"/1.54" — round, all-in-one,
no new case, no camera.

**With vision — the size gap forces a choice:** cased-with-camera jumps from 2"
(CoreS3) straight to 5" (Tab5); nothing cased-with-camera exists in the 2.4"–2.8"
range.
- **A — Stay cased, accept the size jump: M5Stack Tab5** (~$55, ESP32-P4) — 5"
  1280×720 IPS touch, **2 MP camera**, mic + speaker, IMU, RTC, enclosed. Reads as
  a small tablet / mini Show rather than a watch.
- **B — Stay minimal, bare board + off-the-shelf case:** ESP32-S3 2.8" board
  (mic + speaker + touch + LiPo, ~$25) + OV2640 camera, in a stock project box
  (e.g. Hammond 1551-series) or a print-service shell (not self-printed).

**Recommendation:** for a genuinely "minimally wider" all-in-one with no new case,
use the **1.85C** and skip the camera. Only add vision here if this unit truly
needs it — then Tab5 (cased, bigger) or path B (minimal, generic box).

---

## Optional bonus sensors (welcomed)

The M5Stack picks make this nearly free:

- **Already onboard (CoreS3 / Tab5):** ambient-light + proximity sensor, IMU
  (motion / tap-to-wake), camera (visual presence), RTC.
- **Solderless add-ons via Grove port** (M5Stack ecosystem):
  - **PIR / mmWave human-presence sensor** — wake the screen / trigger ambient
    greetings when someone enters the room
  - **ENV unit** — temperature, humidity, barometric pressure for local readouts
  - **Light unit** — auto screen brightness / "is the room dark" routines
  - **CO₂ / air-quality, sound-level, etc.** — optional household telemetry

Presence + light + temp feed naturally into the daily-briefing / ambient-context
system and unprompted behaviors (e.g. "good morning" when motion is detected).

---

## Stands, bases & mounting (physical placement)

Like the Echo Show's weighted, angled base, each device needs to be stable, at a
usable viewing angle, and not easily knocked over. The good news: the displays
expose **universal mount interfaces**, so off-the-shelf stands work — no printing
required. The catch is *desktop tilt*: most device-specific angled stands online
are 3D-printed, so for a no-print build, use generic adjustable easels / tripod
mounts / weighted bases instead.

### Per-device needs

| Device | Placement | Stability/angle need | No-print solution |
| --- | --- | --- | --- |
| **Atom Echo** (Dot) | Counter / shelf | Tiny + very light → a USB-C cable tug topples it | Set in a small weighted holder or stick down with an adhesive pad; route cable with strain relief. (Device-specific holders exist but are 3D-printed.) |
| **CoreS3** (Show/watch) | Counter or wall | Needs viewing tilt; anti-tip | **Ships with DinBase** → wall / screw / DIN-rail / LEGO-hole mount out of the box. For a tilted *desk* Show, set it in a generic adjustable phone/tablet easel stand. |
| **CoreS3 SE** (Show, no cam) | Same as CoreS3 | Same | Same — DinBase + generic easel |
| **Tab5** (wider watch, vision) | Counter / desk | Tablet-sized → needs a real kickstand + anti-tip | **Built-in 1/4″-20 tripod nut** → any off-the-shelf mini-tripod, desk arm, or 1/4-20 tablet mount. Universal, no print. |
| **Waveshare 1.28-B** (round watch) | Desk puck *or* worn | Round metal puck → wants a small tilt cradle | Generic mini watch/display easel cradle; or a magnetic USB-C charging dock to set it on. |
| **LilyGO T-Watch S3** (round watch) | **Worn** | Wearable — uses a strap | Ships as a watch with a **standard strap**; for desk use, a generic watch charging stand. |
| **Waveshare 1.85C** (wider watch box) | Counter | Box footprint is stable; may want slight tilt | Sits as-is; optional small easel for tilt. |

### Universal mount interfaces (why no printing is needed)

- **1/4″-20 tripod thread (Tab5)** — the standard camera/tripod thread; fits a
  huge range of off-the-shelf desk stands, gooseneck arms, and mini-tripods.
- **DinBase (CoreS3 / SE)** — 35 mm DIN-rail, 4 detachable screw/wall "hanging
  ears," and LEGO mounting holes. Covers wall and panel mounting out of the box.
- **Standard watch lugs/strap (T-Watch S3)** — wearable with common bands.
- **Generic adjustable easel / phone-tablet desk stand** — works for any of the
  flat-front displays (CoreS3, 1.28-B, 1.85C) to set the viewing angle.

### Cross-cutting placement notes

- **Anti-tip / weighting:** the battery in CoreS3/1.85C/T-Watch lowers the center
  of gravity. The featherweight **Atom Echo** is the main tip risk — weight it or
  stick it down, and add cable strain relief.
- **Charging (battery devices):** a **magnetic USB-C / pogo-pin charging dock**
  lets a watch-class device be "set down to charge" like a real smartwatch, and
  doubles as its desk stand. Off-the-shelf magnetic USB-C adapters work without a
  custom cradle.
- **Wall vs. desk:** CoreS3's DinBase makes a wall-mounted hallway/kitchen panel
  (the original `VISION.md` use case) a no-print job; desk use just adds a generic
  easel.
- **Print-service fallback:** where only a 3D-printed device-specific stand looks
  right (e.g., a custom Atom Echo desk "monster" or a Tab5 angled cradle), order it
  from a print service rather than self-printing — still satisfies "no printer at
  home."

---

## Summary

| Scenario | Device | Price | Screen | Mic | Spkr | Cam | Batt | Onboard sensors | Case |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Echo Dot | M5Stack Atom Echo | ~$13 | — (RGB) | ✅ | ✅ | — | — | — (Grove add-on) | ✅ enclosed |
| Echo Show (vision) | M5Stack CoreS3 | ~$45 | 2.0" | dual | ✅ | ✅ | ✅ | light, prox, IMU | ✅ enclosed |
| Echo Show (no cam) | M5Stack CoreS3 SE | ~$30 | 2.0" | dual | ✅ | — | ✅ | — | ✅ enclosed |
| Watch (vision) | M5Stack CoreS3 | ~$45 | 2.0" sq | dual | ✅ | ✅ | ✅ | light, prox, IMU | ✅ enclosed |
| Watch (no cam, round) | Waveshare 1.28-B / LilyGO T-Watch S3 | ~$30 / ~$40 | 1.28"–1.54" | ✅ | ✅ | — | ✅ | IMU | ✅ enclosed |
| Wider watch (no cam) | Waveshare 1.85C | ~$30–40 | 1.85" rnd | ✅ | ✅ | — | ✅ | — | ✅ enclosed |
| Wider watch (vision) | M5Stack Tab5 *(or 2.8"+OV2640)* | ~$55 *(~$30)* | 5" *(2.8")* | ✅ | ✅ | ✅ | IMU | ✅ enclosed *(stock box)* |

**Common firmware base:** ESP32-S3 (Tab5 = ESP32-P4) + PSRAM, openWakeWord
TFLite-Micro, WebRTC-VAD, the binary WebSocket Pod protocol, BLE provisioning,
OTA. Watches add RTC-backed local alarm scheduling; Dot/Show rely on the
persistent Host connection for unprompted responses.

## Open decisions

1. **Per screened device — vision or all-in-one?** For the Show and each watch,
   decide whether that unit needs a camera (→ CoreS3 / Tab5, boxy) or should be the
   smaller/round all-in-one (→ CoreS3 SE / 1.28-B / T-Watch S3 / 1.85C, no camera).
   For Scenario 4's vision path specifically: Tab5 (cased, 5") vs. bare 2.8" board
   + project box (minimal width).
2. **Which Host(s)** these Pods stream to, and whether the Show should instead be
   a Host (Raspberry Pi 5 + DSI) for local video calling.
3. **Battery strategy** for the watches: always-listen vs. tap-to-wake vs. low-power
   wake co-processor.
4. **Stand / mount per device:** wall-mount (CoreS3 DinBase) vs. desk easel vs.
   Tab5 tripod mount; and whether battery devices get a magnetic USB-C charging
   dock that doubles as the stand.
4. **Prototype order** — recommend Atom Echo (Dot) first to validate the wake-word
   + Host streaming path end-to-end, then CoreS3 for the screened/camera path.

## Sources

- [M5Stack Atom Echo](https://shop.m5stack.com/products/atom-echo-smart-speaker-dev-kit) · [Atom VoiceS3R](https://shop.m5stack.com/products/atom-echos3r-smart-speaker-dev-kit) · [$13 HA smart speaker (XDA)](https://www.xda-developers.com/home-assistant-voice-control-with-atom-echo-smart-speaker/)
- [M5Stack CoreS3](https://shop.m5stack.com/products/m5stack-cores3-esp32s3-iotdevelopment-kit) · [CoreS3 SE (CNX)](https://www.cnx-software.com/2024/05/31/m5stack-cores3-se-cost-down-esp32-s3-iot-controller-features-a-2-inch-touch-display-a-microsd-card-slot-a-speaker-two-microphones/)
- [M5Stack Tab5 (ESP32-P4)](https://shop.m5stack.com/products/m5stack-tab5-iot-development-kit-esp32-p4) · [Tab5 docs](https://docs.m5stack.com/en/core/Tab5)
- [Waveshare ESP32-S3-Touch-LCD-1.85C](https://www.waveshare.com/esp32-s3-touch-lcd-1.85c.htm) · [1.28-B CNC metal case](https://www.waveshare.com/esp32-s3-touch-lcd-1.28-b.htm) · [4.3" Type B with Case (Amazon)](https://www.amazon.com/waveshare-ESP32-S3-4-3inch-Touch-Case/dp/B0DD6VLH1Y)
- [LilyGO T-Watch S3](https://lilygo.cc/products/t-watch-s3) · [Waveshare ESP32-S3-AUDIO-Board](https://www.waveshare.com/esp32-s3-audio-board.htm)
- Mounting: [M5Stack DinBase docs](https://docs.m5stack.com/en/base/DIN%20BASE) · [Tab5 docs (1/4″-20 tripod nut)](https://docs.m5stack.com/en/core/Tab5) · [Tab5 wall/panel mount thread](https://community.m5stack.com/topic/7690/tab5-wall-panel-mount)
</content>
</invoke>
