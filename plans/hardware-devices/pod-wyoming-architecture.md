# Loki Doki Pods — Software Architecture (Wyoming-compatible)

Status: **proposal / not yet built** · Last updated: 2026-06-23

Companion to [`README.md`](./README.md) (hardware selection) and
`docs/src/content/docs/dev/hardware.md`. That doc picks the *devices*; this doc
specifies the **software** — how a dumb ESP32 device ("Pod") gets its brains from
the Loki Doki backend ("Host").

## TL;DR decision

Build the Pod ↔ Host link on the **Wyoming protocol** instead of a bespoke binary
framing. Wyoming is the de-facto standard for voice satellites (Home Assistant,
Rhasspy, `wyoming-satellite`), it is dead simple on an ESP32 (newline-delimited
JSON headers + raw PCM over a TCP socket), and it is exactly the
"dumb-node-streams-to-a-real-computer" pattern already proven by **OmniBot** and
**Home Assistant**.

- **Protocol:** Wyoming (events + raw PCM). Implement a Wyoming-speaking endpoint
  in the backend; ESP32 firmware is a Wyoming **satellite client**.
- **Wake word:** server-side **openWakeWord** (reuses models we already ship; Pod
  streams audio and stays maximally dumb). On-device **microWakeWord** is the
  later option for battery devices that can't stream continuously.
- **Brains:** reuse the existing STT (whisper), TTS (Kokoro), chat/router, and
  vision stacks — Wyoming is mostly a **re-framing** of WebSocket protocols we
  already have, not a rewrite.
- **Echo-Show display layer** (companion face, clock/weather/alarms on screen) is
  a **Loki Doki extension on top of Wyoming** (Wyoming has no display concept).
- **Firmware reuse is real but nuanced** — see "Firmware paths" below. Stock
  ESPHome `voice_assistant` is *not* directly reusable (it targets HA's native
  API); we reuse ESPHome's board/Wi-Fi/OTA/audio components + a custom Wyoming
  client, or go ESP-IDF.

### Correction to the existing hardware docs

The current `README.md` / `hardware.md` say **"openWakeWord TFLite-Micro on the
ESP32-S3."** That combination is wrong: openWakeWord is too large for an ESP32.
On-device wake word means **microWakeWord** (a different, tiny model); openWakeWord
runs **server-side**. This plan assumes server-side openWakeWord by default. (The
two hardware docs should get a one-line fix to match.)

---

## Why Wyoming (validation)

| Source | What they do | Match |
| --- | --- | --- |
| **OmniBot** (this user's project) | XIAO ESP32-S3 streams mic+cam over WebSocket to a PC hub; **hub runs wake word + VAD**, calls model, streams PCM back; BLE Wi-Fi provisioning; round display shows face/status | Same dumb-Pod → Host pattern, custom WS |
| **Home Assistant** | ESP32 "voice satellite" streams audio; **Assist pipeline** does wake/STT/intent/TTS; **Wyoming** is the standard protocol for the service/satellite links | Same pattern, *standardized* protocol |

Adopting Wyoming = OmniBot's architecture, but on the documented standard everyone
else targets, so off-the-shelf satellites and tooling interoperate.

---

## Architecture overview

```
┌─────────────────────────────┐         Wyoming over TCP          ┌──────────────────────────────┐
│  POD (ESP32-S3 / -P4)        │   (newline-JSON + raw PCM)        │  HOST = Loki Doki backend      │
│                              │ ───── audio-start/chunk/stop ───▶ │                                │
│  • I2S mic  ───────────────► │                                   │  Wyoming endpoint (NEW)        │
│  • I2S speaker ◀──────────── │ ◀──── audio-start/chunk/stop ──── │   ├─ wake: openWakeWord (svr)  │
│  • LVGL display ◀─ user-event│ ◀──── detection / handled-chunk   │   ├─ asr:  SttSession+whisper  │
│  • camera ──── user-event ─► │ ───── user-event(image) ────────▶ │   ├─ tts:  Kokoro (reframed)   │
│  • RTC (battery devices)     │ ◀──── user-event(display/fire) ── │   ├─ "handle": chat/router     │
│  • wake (mWW) OR stream-all  │                                   │   └─ scheduler (NEW)           │
│  Wyoming satellite client    │                                   │  device identity (NEW)         │
└─────────────────────────────┘                                   └──────────────────────────────┘
                                                                      reuses: routes/stt.ts, sttSession,
                                                                      routes/tts.ts, kokoroEngine, chat.ts,
                                                                      llm/router.ts, vision, briefing
```

Connection model: the **Pod connects out to the Host** (one persistent TCP
socket). That persistent bidirectional link is also the **push channel** —
alarms, timers, notifications, and ambient "good morning" reach the Pod over the
same socket, which removes the "no push" gap entirely (no polling needed).

---

## Wyoming protocol cheat-sheet (what we implement)

Wire format — newline-JSON header, optional JSON data block, optional binary
payload:

```
{"type":"audio-chunk","data":{"rate":16000,"width":2,"channels":1},"payload_length":3200}\n
<3200 bytes raw int16 PCM>
```

Events we use:

- **Audio:** `audio-start` / `audio-chunk` / `audio-stop` (`rate`,`width`,`channels`)
- **Wake:** `detect` (names) → `detection` (name) / `not-detected`
- **VAD:** `voice-started` / `voice-stopped`
- **STT:** `transcribe` → `transcript` (`text`)  (+ streaming `transcript-chunk`)
- **TTS:** `synthesize` (`text`,`voice`) → `audio-start`/`audio-chunk`/`audio-stop`
- **Handle (our LLM turn):** `handled` / `handled-chunk` / `handled-stop` (response text)
- **Pipeline/satellite control:** `run-pipeline` (`start_stage`,`end_stage`,
  `wake_word_names`,`restart_on_end`), `run-satellite`, `pause-satellite`,
  `satellite-connected/-disconnected`, `streaming-started/-stopped`
- **Describe/info:** `describe` → `info` (advertise asr/tts/wake/handle/satellite caps)
- **Custom:** `user-event` (`name`,`data`,payload) — our extension carrier for
  display frames, camera images, alarm fires, clock/weather data, device auth

> **Intent vs. conversation:** stock Wyoming assumes an *intent* pipeline
> (`recognize` → `intent` → `handled`). Loki Doki is a conversational LLM, not a
> fixed intent matcher. We **skip the `recognize`/`intent` stage** and run our own
> `transcript → chat/router → handled-chunk(text) → synthesize` flow, which is a
> legal Wyoming pipeline (`start_stage:"asr"`, `end_stage:"tts"`, handle in the
> middle). `directReply`/`passMessage` Tier-1 routing stays as-is.

---

## Compatibility assessment — what we already have vs. Wyoming

The backend is ~70% of the way there; most work is **re-framing**, not new logic.

| Capability | Loki Doki today | Wyoming target | Work |
| --- | --- | --- | --- |
| **Mic stream** | `routes/stt.ts` WS: `{t:'hello',sample_rate}` + binary **float32** frames | `audio-start`+`audio-chunk` (int16, `width:2`) | Re-frame; convert float32→int16 (or accept both); map `hello`→`audio-start` |
| **STT** | `SttSession` (RMS VAD, partials, 0.7s silence finalize) → `{t:'final'}` | `transcribe`→`transcript`; VAD→`voice-started/stopped` | **Reuse `SttSession` as-is**; rename emitted events |
| **TTS** | `routes/tts.ts` NDJSON `SentencePayload` (`pcm_b64`, int16, 22050) via `sentenceSegmenter` + `kokoroEngine` | `synthesize`→`audio-start`/`audio-chunk`/`audio-stop` | **Reuse Kokoro + segmenter**; base64 NDJSON → raw-PCM Wyoming chunks; resample 22050→16000 if Pod wants one rate |
| **Wake word** | client-side `onnxruntime-web` openWakeWord (browser) | server-side openWakeWord → `detection` | **Move openWakeWord to backend** (Node `onnxruntime-node` already used by voice sidecar); run on streamed audio. Reuses existing `.onnx` models |
| **LLM turn** | `routes/chat.ts` (`routePrompt`, `directReply`, `ollamaChatStream` SSE tokens) | `handled-chunk` stream | Wrap existing chat path; SSE tokens → `handled-chunk`; trigger `synthesize` per sentence |
| **Vision** | `routes/vision.ts` VLM; chat image attach is **TODO/unwired** | none (no Wyoming vision) | `user-event{name:"image"}` + JPEG payload → existing VLM; finish the chat attach wiring |
| **Briefing/weather/clock** | warm cache, **no public endpoint** (companion-prompt only) | none | `user-event{name:"display.data"}` push; add small internal accessor |
| **Alarms/timers** | **client-side firing only** (`TimeAlarmContext`); backend stores defs (`routes/time.ts`) | none | **Server scheduler (NEW)** → `user-event{name:"fire"}` over the socket |
| **Notifications** | poll-only (`routes/notifications.ts`) | none | Push as `user-event{name:"notify"}` over the persistent socket |
| **Auth/identity** | user sessions + PIN; **no device concept** | Wyoming has no auth | **`devices` table + handshake (NEW)** via first `user-event{name:"auth"}` or `info` |

### Gaps that remain regardless of protocol (the genuinely new code)

1. **Device identity** — `devices` table (id, userId, name, kind, tokenHash,
   capabilities JSON, lastSeen). Pairing: BLE provisioning delivers a one-time
   code → `POST /api/pod/pair` mints a long-lived device token. Pod authenticates
   the Wyoming socket with that token in its opening handshake.
2. **Server-side scheduler** — the keystone. Knows every alarm/timer's absolute
   fire time, pushes a fire-event over the socket (mains Pods) and syncs absolute
   times to onboard RTC (battery Pods). Also hardens alarms for the *browser* app
   (today they only fire if a tab is open).
3. **Display/companion-face channel** — Wyoming has no screen concept. Define a
   Loki Doki `user-event` sub-vocabulary: `display.face` (viseme/expression
   state, not pixels — Pod renders LVGL locally), `display.data` (clock/weather/
   timer fields), `display.fire` (alarm ring screen). Keeps the wire light and
   the Pod's renderer dumb-but-local.

---

## Backend workstreams

All under a new `backend/src/lib/pod/` + `backend/src/routes/pod.ts`:

1. **Wyoming endpoint** — `pod/wyoming/` codec (header parse/serialize, payload
   framing) + a `WyomingSatelliteSession` that owns one Pod connection and drives
   the pipeline. Transport: raw TCP (Wyoming default) — note Bun TCP, not the
   Hono/Bun WS path (`index.ts` `websocket` export gotcha doesn't apply to a TCP
   listener; pick the port, e.g. 10700).
2. **Pipeline orchestrator** — server-side port of the frontend hands-free FSM
   (`frontend/src/lib/voice/handsfree-state-machine.ts`): `idle → wake → capture
   → handle → speak → post-reply-listen`. Wire to `SttSession`, server
   openWakeWord, chat path, and Kokoro.
3. **Server openWakeWord** — `pod/wake.ts` running the existing models under
   `onnxruntime-node`; emits `detection`.
4. **TTS re-framer** — adapt `routes/tts.ts` output to Wyoming `audio-chunk`s
   (reuse `sentenceSegmenter` + `kokoroEngine`; barge-in maps to `audio-stop`).
5. **Device identity + pairing** — schema + `routes/pod.ts` pair endpoint
   (follow `project_db_migrations` belt-and-suspenders pattern).
6. **Scheduler** — `pod/scheduler.ts`; reads `clockAlarms`/`clockTimerRuns`;
   pushes fire-events; RTC sync for battery devices.
7. **Display extension** — `user-event` encoders for face/data/fire; feed from
   companion appearance config + briefing cache.

## Companion face on the Tab5 (animated character)

The Echo-Show differentiator: an animated companion on the 5" screen that
**mouths responses** and shows expressive states (thinking, sleeping, listening).
This resolves **open decision #2** in favour of **state-based, render-local**:
the Host streams *what the character is doing*, the Tab5 renders it locally with
LVGL. No pixel streaming — the wire stays tiny and animation stays smooth.

### Hardware fit (confirmed)

ESP32-P4 is the most capable ESP32 (RISC-V dual-core, hardware 2D accel "PPA",
hardware JPEG decoder); Tab5 ships 32MB PSRAM. **LVGL runs at ~60 FPS on the
Tab5**, with **Lottie + SVG vector animation built in via ThorVG**. Program via
ESP-IDF (firmware Path A) or Arduino + M5Unified/M5GFX.

### Architecture

```
Host pipeline FSM ──user-event{name:"face.state"}──▶ Tab5 plays matching LVGL animation
TTS audio          ──audio-chunk (PCM)─────────────▶ Tab5 plays audio AND derives MOUTH from it
```

- **States come free from the pipeline FSM** — the Host just emits its current
  state; no new server logic:

  | Pipeline state | Character animation |
  | --- | --- |
  | idle (short) | idle / blink loop |
  | idle (long, timeout) | **sleeping** (Zzz) |
  | wake / capturing | **listening** (lean in) |
  | handle / LLM generating | **thinking** (look up, dots) |
  | speak / TTS playing | **talking** + live mouth |
  | post-reply | back to idle |

- **Lip-sync from audio, on-device.** The Tab5 computes mouth openness from the
  **RMS amplitude of the PCM it is already playing** (loud → open, quiet →
  closed). No phoneme/viseme data from the Host, and the mouth always matches the
  actual audio. This is the same philosophy as the existing **text-cadence
  lip-sync** — true A/E/O visemes would need phoneme timing Kokoro doesn't expose,
  so amplitude-based is the right call.

### Rendering stack (recommended)

- **States** (thinking/sleeping/blink/listening): **Lottie clips** via ThorVG —
  small, smooth, scalable.
- **Mouth**: a few mouth-shape sprites (closed / half / open) swapped by the
  amplitude value, or one mouth shape scaled by it.
- **Skip Rive for now** — conceptually the right state-machine tool (and
  `characters.renderer` already anticipates a `'rive'` value), but no native LVGL
  support → custom port. Lottie + sprites delivers everything above today.
- *Alt for pixel-exact art*: full sprite-sheet frame animation per state (P4's
  hardware JPEG decoder handles it); heavier on storage/art labour.

### Tie-in to the existing companion system

The Tab5 is a **new renderer** alongside `dicebear` (e.g. `renderer:'lvgl'`):
reuse the character's identity/config (name, colours, personality), but produce a
matching animated art set per device — the browser's DiceBear SVG renderer can't
run on the ESP32. *Consistency option:* ThorVG can render SVG, so the Tab5 could
display the actual DiceBear face as a static base with animated mouth/eye layers
overlaid, keeping the same look as the web app.

### Wyoming display vocabulary (concrete)

- `user-event{name:"face.state", data:{state:"thinking"}}` — Host → Pod state.
- Mouth handled entirely on-device from the `audio-chunk` stream (no event).
- (Other display extensions reuse the same carrier: `display.data` for
  clock/weather/timer, `display.fire` for alarm ring.)

### First milestone

Get an **idle + blink + talking(mouth-from-audio)** loop running on the Tab5
driven by a *hardcoded* state, **before** wiring it to the live pipeline. The
engineering is straightforward; the real work is designing the character's state
animations (art-driven).

## Firmware paths (honest scoping)

Reuse is real, but **stock ESPHome `voice_assistant` is not directly reusable** —
it speaks HA's protobuf native API, not Wyoming. Options, in order of recommend:

- **A — ESP-IDF + tiny Wyoming client (recommended for shipping).** Wyoming is
  trivial here: a TCP socket, JSON header writer/reader, PCM in/out. Full control
  of LVGL face + camera + RTC. Most work, best fit for the Echo-Show display layer.
- **B — ESPHome (board/Wi-Fi/OTA/audio/microWakeWord components) + custom
  external component** that speaks Wyoming to Loki Doki. Reuses ESPHome's hardware
  abstractions and OTA for free; you write the Wyoming client as a component.
- **Test harness — `wyoming-satellite` on a Pi Zero 2 W** (or a Node script).
  *Not a shipping device* (the hardware doc bans Raspberry Pi), but the fastest way
  to validate the Host's Wyoming endpoint end-to-end **with zero firmware**.

Wake word: default **stream-all + server openWakeWord** (dumbest Pod, reuses our
models). For battery watches, switch to **microWakeWord on-device** to avoid
continuous streaming.

---

## Phasing / prototype order

1. **Wyoming endpoint + pipeline + server openWakeWord**, validated against the
   **`wyoming-satellite` test harness** (no hardware). Proves the brain end-to-end.
2. **Device identity + pairing.**
3. **Server-side scheduler** (independently valuable; hardens browser alarms too).
4. **Atom Echo (Dot)** firmware — Path A/B; real wake-word + bidirectional audio
   on the cheapest board.
5. **Tab5 (Show)** — add the display/companion-face `user-event` layer + camera.
6. **Watch tier** — microWakeWord on-device + RTC-backed local alarms + power mgmt.

## Open decisions

1. **TTS sample rate** — resample Kokoro 22050→16000 server-side for one Pod rate,
   or advertise capability and let the Pod handle 22050?
2. ~~**Face on screen** — push state vs. rasterized frames.~~ **Resolved:
   state-based, render-local** (Lottie + audio-RMS mouth) — see "Companion face
   on the Tab5." Remaining sub-question: produce a bespoke `lvgl` art set vs.
   render the DiceBear SVG via ThorVG for visual parity with the web app.
3. **Full Wyoming service split** vs. one combined satellite-facing endpoint. Start
   combined; split into discrete `asr`/`tts`/`wake` Wyoming services later only if
   we want HA interop.
4. **microWakeWord training** — needed for on-device wake on battery devices
   (different toolchain than our openWakeWord pipeline).

## Sources

- Wyoming protocol: [OHF-Voice/wyoming](https://github.com/OHF-Voice/wyoming) ·
  [spec](https://julianbei.github.io/wyoming/03-protocol/) ·
  [HA Wyoming integration](https://www.home-assistant.io/integrations/wyoming/) ·
  [rhasspy/wyoming-satellite](https://github.com/rhasspy/wyoming-satellite)
- Wake word: [HA approach to wake words](https://www.home-assistant.io/voice_control/about_wake_word/) ·
  [ESPHome microWakeWord](https://esphome.io/components/micro_wake_word/) ·
  [ESPHome voice_assistant](https://esphome.io/components/voice_assistant/)
- Precedent: [HA ESPHome voice satellite](https://community.home-assistant.io/t/esphome-voice-satellite-voice-assistant-on-a-esp32/719865) ·
  OmniBot (`/Users/jessetorres/Projects/OmniBot`)
</content>
</invoke>
