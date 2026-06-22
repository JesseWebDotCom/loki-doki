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

### Camera ("vision") devices (both watches)

- Onboard camera for presence detection and image capture/attach

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

**With vision — M5Stack CoreS3** (~$45), ships enclosed with a DinBase mount.
2.0" glass capacitive touch, 0.3 MP camera, dual mic (ES7210), 1 W speaker
(AW88298), 500 mAh battery, RTC. **Bonus onboard sensors:** ambient-light +
proximity (LTR-553), IMU (BMI270).

**Without vision (all-in-one, same case/size) — M5Stack CoreS3 SE** (~$30) —
identical 2" cased body, mic + speaker + RTC, no camera (also drops proximity and
IMU). Drop-in if the Show doesn't need video/presence.

**Bigger screen (cased) — Waveshare ESP32-S3-Touch-LCD-4.3 "Type B with Case"**
(~$50) — 4.3" 800×480 IPS in an enclosure. *Caveat:* no onboard mic/speaker; you
add a USB/I2S mic+speaker.

### 3. Apple-Watch-sized + battery — ~1.3–2" cased

**With vision — M5Stack CoreS3** (~$45). Camera + dual mic + speaker + 500 mAh
battery + RTC + light/proximity + IMU in a ~2" square body (not a round watch).

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
  camera, in a stock project box (e.g. Hammond 1551) or print-service shell.

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
| CoreS3 / SE (Show/watch) | Counter or wall | Viewing tilt; anti-tip | Ships with **DinBase** (wall/screw/DIN-rail/LEGO); generic easel for desk tilt |
| Tab5 (wider watch) | Counter / desk | Tablet → kickstand + anti-tip | Built-in **1/4″-20 tripod nut** → any tripod / desk arm |
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
| Echo Show (vision) | M5Stack CoreS3 | ~$45 | 2.0" | dual | ✅ | ✅ | ✅ | ✅ enclosed |
| Echo Show (no cam) | M5Stack CoreS3 SE | ~$30 | 2.0" | dual | ✅ | — | ✅ | ✅ enclosed |
| Watch (vision) | M5Stack CoreS3 | ~$45 | 2.0" sq | dual | ✅ | ✅ | ✅ | ✅ enclosed |
| Watch (no cam, round) | Waveshare 1.28-B / LilyGO T-Watch S3 | ~$30 / ~$40 | 1.28"–1.54" | ✅ | ✅ | — | ✅ | ✅ enclosed |
| Wider watch (no cam) | Waveshare 1.85C | ~$30–40 | 1.85" rnd | ✅ | ✅ | — | ✅ | ✅ enclosed |
| Wider watch (vision) | M5Stack Tab5 (or 2.8"+OV2640) | ~$55 (~$30) | 5" (2.8") | ✅ | ✅ | ✅ | ✅ | ✅ (stock box) |

**Common firmware base:** ESP32-S3 (Tab5 = ESP32-P4) + PSRAM, openWakeWord
TFLite-Micro, WebRTC-VAD, the binary WebSocket Pod protocol, BLE provisioning,
OTA. Watches add RTC-backed local alarm scheduling; Dot/Show rely on the
persistent Host connection for unprompted responses.

:::note
The internal planning version of this document, with open decisions and source
links, lives at `plans/hardware-devices/README.md` in the repository.
:::
</content>
