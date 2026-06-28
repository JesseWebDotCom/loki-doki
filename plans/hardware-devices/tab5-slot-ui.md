# Tab5 Modular Slot-Based UI — server↔device contract

**Status:** Server + admin implemented; device (LVGL) side TODO.
**Companion to:** [pod-wyoming-architecture.md](./pod-wyoming-architecture.md).

This documents the contract the **server already speaks** so the Tab5 firmware can be
built to match. The whole point: layout, colours, sounds, and alarms are **server-side
config pushed over the existing Wyoming socket — never a re-flash**. The firmware ships
every widget pre-built and just shows/places/themes per a descriptor.

What's built (server + admin):
- DB: `device_layout_templates`, `device_sound_packs`, `device_chimes`; `devices`
  gains `layout_template_id` + `layout_overrides`; `clock_alarms` gains `tone_id` +
  `targets`.
- Admin → Devices → **Layouts** (3×3 grid editor + device-accurate preview + assign),
  **Sounds** (packs + per-event grid + chime/alarm-tone designer with browser preview),
  **Alarms** (server-owned, device-targeted, coordinated dismiss).
- Server-side chime synthesis (`lib/pod/audioSynth.ts`) → 16 kHz mono WAV at
  `data/pod/audio/<id>.wav`, served by `GET /api/pod/audio/<id>.wav`. Built-ins are
  rendered at boot by `deviceStudio.ensureBuiltins()`.
- Centralised alarm firing engine (`lib/pod/scheduler.ts`): targets devices, resolves
  the tone (per-alarm → device template default → fallback), snooze + coordinated stop.

## Decisions locked (from the design doc's open questions)
1. **Reserved bottom-center:** Option A — the voice pill is a `lv_layer_top()` overlay;
   slot `[2,1]` stays assignable.
2. **Grid:** fixed `3x3` for v1 (`grid` field leaves room for others later).
3. **Medium orientation default:** `horizontal` when omitted.
4. **Wake sound:** fires **locally on-device** the instant wake is detected. The server
   owns every other earcon.
5. **Audio format:** 16 kHz mono 16-bit WAV (matches the I2S/codec rate, no resampling).
6. **Day/night:** the server supplies `is_night` in live weather values; the device may
   override from RTC. The admin preview has a manual day/night toggle.
7. **Alarm engine:** server-owned (the device RTC is not the source of truth).
8. **Custom-asset sync:** pull-from-URL — the server sends an `asset_sync` manifest
   (url + sha256); the device fetches missing/changed WAVs to SD once.

## Messages — server → device (all on Wyoming `user-event`, keyed by `name`)

### `layout` — the full dashboard descriptor
Pushed on (re)connect and on any template/assignment edit. The device hides all grid
widgets, then for each entry selects the size-variant, positions it at the anchor's
pixel origin (cell ≈ 426×240 at 1280×720, gutter 12), applies theme tokens, shows it.
Then it caches the resolved `sound_pack.events` map.

```jsonc
{ "name": "layout", "type": "layout", "template_id": "cozy_dark",
  "theme": { "bg": "#0E0B1A", "accent": "#7C3AED", "text": "#EAEAF2", "font_scale": 1.0 },
  "widgets": [
    { "type": "clock",   "size": "large",  "anchor": [0,0] },
    { "type": "weather", "size": "medium", "anchor": [0,2], "orient": "vertical" },
    { "type": "mic",     "size": "small",  "anchor": [2,0] },
    { "type": "mute",    "size": "small",  "anchor": [2,2] }
  ],
  "sound_pack": { "pack_id": "builtin:chimes", "volume": 0.7, "alarm_volume": 1.0,
    "events": { "wake": "/api/pod/audio/builtin_wake_bright.wav", "thinking": null, … } },
  "alarm_tone": "/api/pod/audio/builtin_alarm_gentle.wav" }
```
Widget sizes: `small` 1×1, `medium` 1×2 (horizontal) or 2×1 (vertical), `large` 2×2.
Each widget renders **different internal detail per size** (clock: time → +date → +day/seconds;
weather: icon+temp → +condition → animated bg+hi/lo). Audio URLs are server-relative —
resolve against the configured `lokidoki_host`. `null` = silent for that event.

### `sound` — play a UI earcon
```jsonc
{ "name": "sound", "event": "success" }
```
Look up `event` in the cached pack map; if non-null, play that WAV at `volume`, **off the
LVGL task**. `wake` is normally played locally before the server is even informed.

### `asset_sync` — fetch custom WAVs to SD
Sent before a layout that references custom (non-`builtin:`) chimes. Built-ins ship in
flash and never appear here.
```jsonc
{ "name": "asset_sync", "pack_id": "…",
  "files": [ { "path": "abc123.wav", "url": "http://<host>:3000/api/pod/audio/abc123.wav", "sha256": "…" } ] }
```
Fetch each missing/changed file (compare sha256), store on SD, then the chime is playable.

### `alarm_fire` / `alarm_stop` — centralised alarms
```jsonc
{ "name": "alarm_fire", "alarm_id": "wk-0700", "label": "Wake up",
  "tone_url": "/api/pod/audio/builtin_alarm_birdsong.wav", "snooze_minutes": 9 }
{ "name": "alarm_stop", "alarm_id": "wk-0700" }
```
On `alarm_fire`: show the alarm screen (label + snooze/cancel), loop `tone_url` at the
**alarm volume**, ignoring the global earcon mute (an alarm must never fail silently).
On `alarm_stop` (coordinated dismiss from another device): stop the loop + leave the screen.

## Messages — device → server (Wyoming `user-event`)

### `alarm_action` — snooze/cancel tapped on the device
```jsonc
{ "name": "alarm_action", "alarm_id": "wk-0700", "action": "snooze" }  // snooze | cancel
```
Stop the local loop, then send this. The server reschedules (snooze = +N min) or silences
it, and broadcasts `alarm_stop` to the other target devices.

Existing `config` / `display.mode` events are unchanged (see pod-wyoming-architecture.md).

## Weather animation catalog (§6.1)
The live weather values carry `{ condition, is_night, temp, hi, lo, text }`. Conditions
(`clear`, `partly-cloudy`, `cloudy`, `fog`, `drizzle`, `light-rain`, `heavy-rain`,
`thunderstorm`, `snow`, `sleet`, `windy`) each resolve to a day/night LVGL treatment —
prefer particle/canvas (B) for rain/snow (themeable: particle colour follows `accent`),
frame-loop (A) for fog/aurora, gradient (C) for clear/cloudy. The admin preview shows a
representative CSS gradient per condition (`frontend/src/lib/pod/layout.ts WEATHER_CATALOG`).

## Device apply logic (firmware TODO)
1. Pre-build every widget's S/M/L variant + the 3×3 placement engine. Hardcode one
   layout to validate, then drive it from the `layout` descriptor.
2. Theme tokens via shared `lv_style_t`; re-apply + `lv_obj_invalidate` on each `layout`.
3. Earcon playback off the LVGL task; built-in WAVs in flash, custom on SD.
4. Alarm screen + local loop; `alarm_action` back to the server.
5. Weather particle engine (rain/snow first), then storm flash, then frame loops.
