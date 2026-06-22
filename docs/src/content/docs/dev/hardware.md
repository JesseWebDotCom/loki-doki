---
title: Hardware Devices
description: Proposed physical Loki Doki devices — Echo Dot/Show replacements and battery wearables — built on the Pod architecture with off-the-shelf, pre-cased ESP32 hardware.
sidebar:
  order: 9
---

Status: **proposal / not yet built**

## Goal

Give Loki Doki physical presence in the home using off-the-shelf hardware that
replaces the Amazon Echo Dot and Echo Show and adds two battery-powered,
camera-equipped wearables. Each device is a **Pod**: a "dumb" ESP32-class node
that does cheap on-device gatekeeping (wake word + voice-activity detection) and
streams to a **Host** — a real computer running the LLM, STT, TTS, and memory.
The Host pushes audio and screen frames back to the Pod.

**Hard constraint:** prefer devices that **ship in a finished enclosure** — no
3D-printed cases. Where a board is bare, an off-the-shelf case (or print-service
shell) is named explicitly.

## Requirements

### Shared (all devices)

| Requirement | How it's met |
| --- | --- |
| Wake word, on-device | openWakeWord TFLite-Micro on the ESP32-S3 |
| Audio responses | I2S speaker; Host streams PCM back (`0x20` frames) |
| Wireless | 2.4 GHz Wi-Fi + BLE 5 (BLE for provisioning) |
| Unprompted responses (alarms/timers) | See *Unprompted-response mechanism* |
| Provisioning / OTA | BLE GATT setup + OTA model/firmware updates |

### Screened devices (Show + both watches)

- Capacitive touchscreen
- On-screen data (clock, weather, timers, alarms, companion face) via LVGL
- Host pushes display/viseme frames (`0x21`)

### Camera ("vision") devices (Show, all sizes + both watches)

- **Front-facing only** — the camera must sit on the *display face*, looking back
  at the user in front of the screen (like the Echo Show's above-screen camera).
  A rear/back-mounted camera is disqualifying for these scenarios.
- Used for presence detection and image capture/attach.

Picks that satisfy this: **Tab5** (2 MP front-facing, display side), **CoreS3**
(camera on the front, below the screen), and consumer **tablets** (front selfie
camera). For the **ESP32-P4-WIFI6 HMI** the camera is a MIPI-CSI module — confirm
it's positioned on the screen face. Where a camera is *added* (bare 2.8" board),
mount it front-facing, above or below the display.

### Power

- Dot, Show: mains-powered (USB-C)
- Both watches: onboard LiPo + charge circuit

## Unprompted-response mechanism

Alarms/timers must fire even when the user didn't just speak.

- **Mains-powered Pods (Dot, Show):** hold a persistent WebSocket to the Host.
  Host fires the event → pushes audio + a screen frame. No battery concern.
- **Battery Pods (watches):** always-on Wi-Fi + always-listening drains a small
  cell fast. Use the **onboard RTC** — the Host syncs alarm/timer times to it, and
  it fires locally even if Wi-Fi is asleep or the Host is offline; Wi-Fi wakes on
  modem-sleep to re-sync.
- **Battery-life reality:** always-on wake word on a LiPo cell is *hours*, not
  days. For all-day wear, accept periodic-listen windows, a tap-to-wake, or a
  low-power wake co-processor.

## Vision vs. all-in-one form factor

Camera + a cased *round-watch* shape **do not coexist** in off-the-shelf parts —
fully-cased camera devices bottom out around a 2" square body. So each screened
device is offered two ways:

- **With vision** — M5Stack Core-class (~2" square box, has camera).
- **Without vision (all-in-one)** — a smaller / round / right-sized board that
  already ships cased, **needs no new case and no enlarging**, but has no camera.

Cased-**camera** devices also have a **size gap**: CoreS3 is 2", and the next
cased-camera device (Tab5) is 5" — nothing cased-with-camera exists between. The
no-camera all-in-one boards fill the 1.28"–1.85" range vision can't reach.

## Proposals

### 1. Echo Dot replacement — speaker puck, no screen, always powered

**Pick: M5Stack Atom Echo** (or newer Atom VoiceS3R) — **~$13**, ships enclosed
(24×24×17 mm puck). Mic + speaker + RGB status LED (Echo-style ring), USB-C
powered. Reference ESPHome wake-word device, which de-risks the wake-word path.
Mains power → persistent WS → trivial unprompted alarms.

**Screen-bearing alternative:** Waveshare ESP32-S3-Touch-LCD-1.85C "Smart Speaker
Box" (~$30–40) — 1.85" round 360×360, dual mic, speaker, battery, in box form.

### 2. Echo Show replacement — large touchscreen, powered, camera

The Echo Show line spans 5.5"–21", and the **Waveshare ESP32-P4-WIFI6 HMI**
family covers that whole range **while staying on ESP32** — one firmware, one Pod
protocol, no Raspberry Pi. Each board is a tablet-style all-in-one with **dual
microphones + echo cancellation, a speaker, 10-point touch, and a 5 MP MIPI-CSI
camera** (onboard on the larger sizes; optional OV5647 module on the 7"/4.3"),
built on ESP32-P4 + an ESP32-C6 for Wi-Fi 6 / BLE 5. Sizes: 4.3", 5", 7", 8",
10.1"; ~$80–117 by size/battery.

- **Show 5** → **M5Stack Tab5** (~$55, ESP32-P4, 5" 1280×720, fully enclosed, 2 MP
  **front-facing** camera, IMU, RTC, 1/4″-20 tripod nut) — the most *finished*
  small unit, zero assembly. Or the **ESP32-P4-WIFI6-Touch-LCD-5** if you want the
  5 MP camera and the same family as the bigger sizes.
- **Show 8** → **ESP32-P4-WIFI6 7"/8" HMI** (720×1280 / larger) — 5 MP camera,
  dual mic, speaker, all onboard.
- **Show 10 / 15** → **ESP32-P4-WIFI6 10.1" HMI** (800×1280, 5 MP camera, dual
  mic, speaker, ~$80–117) — a wall-panel-sized all-in-one that's still ESP32.

**Front-facing camera (required):** the camera must look back at the user. Tab5's
2 MP camera is front-facing. The Waveshare HMI camera is a MIPI-CSI module
(RPi-style FPC) — since these are tablet-style HMIs it sits on the display face,
but **verify the camera orientation and whether your chosen size ships with an
enclosure** (some variants are board-only, and the smaller sizes take the camera
as an add-on module you position yourself).

**Recommendation:** **Tab5** for a fully-cased countertop Show 5 with zero
assembly; the **ESP32-P4-WIFI6 HMI** (7"–10.1") when you want a bigger Show or a
wall panel and want to stay all-ESP32. A consumer wall tablet (Scenario 5) stays
on the menu as the lowest-effort large panel if you'd rather not build at all.

### 3. Apple-Watch-sized + battery — ~1.3–2" cased

**With vision — M5Stack CoreS3** (~$45). Front-facing camera (on the screen face,
below the display) + dual mic + speaker + 500 mAh battery + RTC + light/proximity
+ IMU in a ~2" square body (not a round watch).

**Without vision (all-in-one, true watch shape):**

- **Waveshare ESP32-S3-Touch-LCD-1.28-B** (~$30) — 1.28" round touch in a CNC
  metal case, mic + speaker, IMU, battery. Closest to an actual watch face.
- **LilyGO T-Watch S3** (~$40) — 1.54" cased smartwatch with strap, mic + speaker,
  400 mAh battery, RTC. Wearable out of the box.

### 4. Wider watch (minimally larger screen) + battery

**Without vision (all-in-one, minimally wider, already cased) — recommended:**
**Waveshare ESP32-S3-Touch-LCD-1.85C** (~$30–40) — 1.85" round 360×360 touch, mic
+ speaker, battery, RTC, ships as a finished "Smart Speaker Box."

**With vision — the size gap forces a choice:**

- **M5Stack Tab5** (~$55, ESP32-P4) — 5" 1280×720 IPS touch, 2 MP camera, mic +
  speaker, IMU, RTC, enclosed. Reads as a small tablet, not a watch.
- **Bare ESP32-S3 2.8" board** (mic + speaker + touch + LiPo, ~$25) + OV2640
  camera **mounted front-facing on the screen bezel**, in a stock project box
  (e.g. Hammond 1551) or print-service shell.

### 5. Wall-mounted tablet — dashboard / family panel (Echo Show 15 style)

A wall panel for the family calendar, weather, home control, and glanceable
companion presence — the original `VISION.md` "hallway / kitchen panel." Note the
ESP32-P4-WIFI6 10.1" HMI (Scenario 2) now covers this size as an all-ESP32 Pod, so
this scenario is the **lowest-effort, no-build** alternative when you'd rather buy
a finished tablet than wire up a panel.

**Pick: an off-the-shelf consumer tablet running the Loki Doki web app** — a Fire
HD 8/10 or an inexpensive Android tablet on a wall mount (VESA plate, adhesive
wall dock, or in-wall recessed mount). It's a fully cased "tablet" out of the box:
touch, speaker, mic, and camera all built in, powered from an in-wall or
surface-channel USB feed. **No Raspberry Pi, no flashing, no assembly** — install
the app and hang it on the wall. This is the most dad-friendly large panel.

**Architecture note:** this is a **Client (browser)**, not a Pod — it loads the
web UI from a Host over the LAN. Implications:

- Touch + tap-to-talk + data display + unprompted alarms (web notifications /
  audio while the app is open) work directly.
- A browser can't reliably run always-on wake word in the background, so for
  hands-free **always-listening** wake word, pair the panel with a nearby
  **Atom Echo Pod** (Scenario 1) that handles the wake and hands off to the Host.

So the whole lineup stays to two simple device types a non-technical user can set
up: **cased ESP32 Pods** (now spanning a 1.85" puck up to a 10.1" panel) and,
optionally, **a tablet running the app** for the largest wall panels.

## Optional bonus sensors

- **Already onboard (CoreS3 / Tab5):** ambient-light + proximity, IMU
  (motion / tap-to-wake), camera, RTC.
- **Solderless add-ons via Grove (M5Stack):** PIR / mmWave human-presence,
  ENV (temp/humidity/pressure), light, CO₂ / air-quality, sound level.

Presence + light + temp feed naturally into the daily-briefing / ambient-context
system and unprompted behaviors (e.g. "good morning" on detected motion).

## Stands, bases & mounting

Each device must be stable, at a usable viewing angle, and hard to knock over.
The displays expose **universal mount interfaces**, so off-the-shelf stands work —
no printing required. The catch is *desktop tilt*: most device-specific angled
stands online are 3D-printed, so for a no-print build use generic adjustable
easels / tripod mounts / weighted bases.

| Device | Placement | Stability/angle need | No-print solution |
| --- | --- | --- | --- |
| Atom Echo (Dot) | Counter / shelf | Tiny + light → cable tug topples it | Weighted holder or adhesive pad + cable strain relief |
| CoreS3 (watch, vision) | Counter or wall | Viewing tilt; anti-tip | Ships with **DinBase** (wall/screw/DIN-rail/LEGO); generic easel for desk tilt |
| Tab5 (Show 5 / wider watch) | Counter / desk | Tablet → kickstand + anti-tip | Built-in **1/4″-20 tripod nut** → any tripod / desk arm |
| ESP32-P4-WIFI6 HMI (Show 7–10.1") | Counter or wall | Big panel → tilt stand or wall mount | Waveshare panel enclosure; generic tablet easel or VESA-style wall bracket |
| Wall tablet (10"+ panel) | Wall | Flush/angled; tidy power; anti-theft | Off-the-shelf VESA plate, adhesive wall dock, or in-wall recessed tablet mount |
| Waveshare 1.28-B (round watch) | Desk puck or worn | Round puck → tilt cradle | Mini watch/display easel; or magnetic USB-C charging dock |
| LilyGO T-Watch S3 (round watch) | Worn | Wearable | Ships with a **standard strap**; generic watch charging stand for desk |
| Waveshare 1.85C (wider watch box) | Counter | Box footprint is stable | Sits as-is; optional small easel for tilt |

**Cross-cutting:** the Atom Echo is the main tip risk (weight it / stick it down);
battery devices benefit from a **magnetic USB-C / pogo charging dock** that
doubles as the stand; CoreS3's DinBase makes a wall-mounted hallway/kitchen panel
a no-print job; where only a custom cradle fits, order it from a print service.

## Summary

| Scenario | Device | Price | Screen | Mic | Spkr | Cam | Batt | Case |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Echo Dot | M5Stack Atom Echo | ~$13 | — (RGB) | ✅ | ✅ | — | — | ✅ enclosed |
| Echo Show 5 | M5Stack Tab5 *(or ESP32-P4-WIFI6-LCD-5)* | ~$55 *(~$80)* | 5" | ✅ | ✅ | ✅ front | ✅ | ✅ enclosed |
| Echo Show 8–10 | Waveshare ESP32-P4-WIFI6 HMI (7/8/10.1") | ~$80–117 | 7"–10.1" | dual | ✅ | ✅ 5MP | opt | enclosure varies |
| Wall panel (10"+) | ESP32-P4-WIFI6 10.1" HMI *or* consumer tablet (Client) | ~$80–117 / ~$60–150 | 10.1"–15" | ✅ | ✅ | ✅ | opt/✅ | ✅ |
| Watch (vision) | M5Stack CoreS3 | ~$45 | 2.0" sq | dual | ✅ | ✅ | ✅ | ✅ enclosed |
| Watch (no cam, round) | Waveshare 1.28-B / LilyGO T-Watch S3 | ~$30 / ~$40 | 1.28"–1.54" | ✅ | ✅ | — | ✅ | ✅ enclosed |
| Wider watch (no cam) | Waveshare 1.85C | ~$30–40 | 1.85" rnd | ✅ | ✅ | — | ✅ | ✅ enclosed |
| Wider watch (vision) | M5Stack Tab5 (or 2.8"+OV2640) | ~$55 (~$30) | 5" (2.8") | ✅ | ✅ | ✅ | ✅ | ✅ (stock box) |

**Common firmware base:** ESP32-S3 / ESP32-P4 (Tab5 and the P4-WIFI6 HMIs use
ESP32-P4 + an ESP32-C6 for Wi-Fi 6) + PSRAM, openWakeWord
TFLite-Micro, WebRTC-VAD, the binary WebSocket Pod protocol, BLE provisioning,
OTA. Watches add RTC-backed local alarm scheduling; Dot/Show rely on the
persistent Host connection for unprompted responses. The wall tablet is the one
exception — a browser **Client** with no firmware, paired with an Atom Echo Pod
for hands-free wake. So the whole lineup is just two things a non-technical user
sets up: **cased ESP32 Pods** and **a tablet running the app** — no Raspberry Pi.

:::note
The internal planning version of this document, with open decisions and source
links, lives at `plans/hardware-devices/README.md` in the repository.
:::
