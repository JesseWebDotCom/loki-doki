# LokiDoki Local Companion Device Master Service Design

## 1. Goal

Define a LokiDoki-native path for adding companion devices while
preserving the repo's core constraints:

- local-first runtime
- offline-first behavior after setup
- `run.sh` / `run.bat` entry points
- profile-driven execution
- no Docker dependency
- no cloud inference, TTS, STT, or wake services

This design treats LokiDoki as the single local intelligence core and treats
companion devices as optional embodied clients on the local network.

This document integrates and extends
[`docs/lokidoki-presence-enhancement-design.md`](../lokidoki-presence-enhancement-design.md),
especially:

- presence loop
- privacy state and sensor controls
- social awareness
- focus and interaction policy resolution
- embodiment abstraction
- companion-safe proactive behavior

## 2. Product Shape

LokiDoki should support three deployment shapes without forking the product:

1. Screen-only local assistant
2. Local master service with one companion device
3. Local master service with multiple companion devices

The same user, memory, character, and policy systems should span all three.
Embodiment is an add-on surface, not a separate assistant architecture.

## 2.1 Delivery Strategy

This design is intentionally broader than the first implementation.

We should deliver it in two layers:

- Lean v1
  - one local master service
  - one companion device
  - mic uplink
  - simple face/state rendering
  - subtitle and status rendering
  - explicit privacy indicators
  - explicit user-invoked interaction
- Platform later
  - multi-device coordination
  - advanced presence
  - richer persona packs
  - optional camera-led behavior
  - proactive routines and follow-through

Rule:

- do not make Lean v1 wait on later-platform architecture unless the v1 device
  cannot function without it

## 3. Core Decision

The system should use a thin-bot architecture:

`Companion device(s) <-> local master service <-> LokiDoki orchestrator/memory/models`

Rules:

- All durable memory lives on the master.
- All model execution lives on the master.
- Wake word, STT, routing, memory, policy, and TTS decisions live on the master.
- Bots provide sensors and actuators:
  - mic uplink
  - optional camera uplink
  - display/render surface
  - optional speaker/audio output
  - optional touch/buttons
  - optional BLE provisioning bridge

This keeps the useful master-to-device pattern without introducing a cloud-first
hub shape.

## 4. Relationship To Presence Design

The earlier presence design remains the higher-level behavioral architecture.
This design adds the concrete device layer needed to embody that architecture.

Mapping:

- `lokidoki/presence/*` remains the authority for room state, attention,
  privacy, cooldowns, focus policy, and social context.
- `lokidoki/embodiment/*` becomes the abstraction boundary between presence
  decisions and device-specific output.
- New device-specific transport code should sit under a dedicated gateway layer,
  not inside the core orchestrator.

The master service should consume presence outputs like:

- `presence_update`
- `attention_target`
- `privacy_mode`
- `interaction_policy`
- `ambient_action`
- `companion_action`

Then translate them into device-safe render/audio/LED/display commands.

## 5. High-Level Architecture

### 5.1 New Subsystems

- `lokidoki/device_gateway/`
  - bot registry
  - local auth/session handling
  - WebSocket transport
  - audio/video uplink ingestion
  - device health and heartbeat
- `lokidoki/embodiment/`
  - output intents
  - device capability mapping
  - device renderer adapter
- `lokidoki/presence/`
  - presence loop from the existing design
  - social context
  - focus / schedule / interaction policy
- `lokidoki/persona_packs/`
  - structured persona-pack files and loaders
  - prompt-composition helpers

### 5.1.a Lean v1 Scope

For the first working device, only these pieces are required:

- `lokidoki/device_gateway/`
  - device registry
  - WebSocket transport
  - simple local auth
  - health and connection state
- `lokidoki/embodiment/`
  - output intents for face, subtitle, status, and audio stop/play
- a minimal policy gate
  - enough to honor `wake_word_only`, `do_not_interrupt`, and privacy state

Not required for Lean v1:

- multi-device arbitration
- social participant tracking
- camera inference
- routine learning
- full persona-pack migration
- rich ambient planner behavior

### 5.2 Device Capability Model

Each bot advertises capabilities:

- `audio_in`
- `audio_out`
- `camera`
- `display_round_240`
- `touch`
- `buttons`
- `battery_state`
- `ble_setup`
- `presence_ping`

This lets the master degrade gracefully across:

- desktop-only
- companion device with display but no speaker
- companion device with full A/V
- future alternate embodiments

### 5.3 Master Runtime Flow

1. Bot connects to local gateway.
2. Gateway authenticates the bot and records capability state.
3. Audio/VAD/wake events feed the presence loop.
4. Presence loop resolves whether LokiDoki may engage.
5. If allowed, orchestrator handles the turn.
6. Embodiment layer converts response and presence outputs into device actions.
7. Device renders animation, subtitles, status, and optional audio playback.

## 6. Local Network Contract

### 6.1 Transport

Use a local WebSocket session per bot for bidirectional events.

Upstream bot-to-master events:

- `hello`
- `capabilities`
- `mic_chunk`
- `camera_frame`
- `touch_event`
- `button_event`
- `battery_state`
- `wifi_setup_state`
- `presence_snapshot`
- `device_log`

Downstream master-to-bot events:

- `render.face`
- `render.subtitle`
- `render.status`
- `render.map`
- `render.card`
- `audio.play_pcm`
- `audio.stop`
- `device.config`
- `presence.privacy`
- `presence.focus`
- `session.state`

### 6.2 Trust Rules

- LAN-only by default
- per-device key provisioning
- no dependency on remote broker services
- no raw continuous sensor history persisted by default
- camera frames remain ephemeral unless a user explicitly saves media

## 7. Persona Model Upgrade

The current character system is strong for avatars and prompt overrides, but it
is too thin for embodied companions.

Upgrade path:

- keep SQLite as the source of truth for durable memory and character metadata
- add local persona-pack files for inspectable authored behavior
- compose persona packs with structured character knobs, not giant freeform
  prompts

Recommended persona-pack files:

- `IDENTITY.md`
- `STYLE.md`
- `BOUNDARIES.md`
- `DEVICE_RULES.md`
- `IDLE_BEHAVIOR.md`
- `HEARTBEAT.md`

Do not move durable user memory into markdown files. The memory tiers from
`docs/DESIGN.md` stay authoritative.

### 7.1 Lean v1 Persona Rule

Lean v1 should not start with a full persona-pack migration.

For v1:

- keep the current character catalog and behavior prompt path
- allow only a very small device-specific prompt layer if needed
- treat persona packs as a later platform upgrade

This prevents the first device from being blocked by a wider prompt-system
refactor.

## 8. Presence And Proactivity Integration

The device layer should not invent a new behavior engine. It should expose the
existing presence architecture physically.

Required long-term integrations from the presence design:

- presence loop cadence
- social awareness and participant tracking
- privacy state
- focus mode and interaction policy
- ambient assistance
- routine follow-through

Effective behavior should still resolve through:

`character_profile -> interaction_mode -> focus_policy -> schedule_policy -> interaction_policy -> per-session override`

Bot behavior consequences:

- `do_not_interrupt`: no unsolicited speech, muted expressive animation
- `wake_word_only`: bot stays visually available but silent until wake
- `utility`: brief render and neutral subtitles
- `companion`: warmer idle expression, proactive cues if policy allows

### 8.1 Lean v1 Presence Rule

Lean v1 should use only a narrow presence slice:

- wake word or explicit user action
- speaking/listening/thinking state
- privacy state
- connection state
- optional simple idle expression

Lean v1 should not depend on:

- proactive routines
- room occupancy modeling
- multi-person inference
- camera-led attention targeting

Those belong to later phases after the basic device loop is stable.

## 9. Privacy And Legibility

Every embodied sensor needs visible, inspectable state.

Master UI requirements:

- per-bot privacy dashboard
- current camera/mic state
- current interaction policy
- current focus mode
- why LokiDoki did or did not act

Bot requirements:

- visible listening indicator
- visible muted/privacy indicator
- visible connection state
- explicit setup mode indicator

## 10. Hardware Parts List

### 10.1 Master Service

Required:

- Raspberry Pi 5, 8 GB recommended
- official Pi 5 power supply
- NVMe or high-end microSD storage
- case and cooling

Optional:

- Hailo-8L accelerator for `pi_hailo`
- USB microphone if room audio is handled at the master instead of the bot
- USB speaker if room audio is handled at the master
- local display for kiosk/admin mode

### 10.2 Companion Device v1

Required:

- Seeed XIAO ESP32S3 Sense
- Seeed XIAO Round Display
- stable USB power or battery pack
- enclosure / mount

Recommended:

- small amplified speaker if audio should play from the bot
- compact microphone path if the onboard path is insufficient
- accessible setup button

Optional:

- battery and charge board
- LED or status light
- IMU / touch refinements
- docking base

### 10.3 Network And Provisioning

Required:

- local Wi-Fi network

Recommended:

- BLE provisioning path for first boot and Wi-Fi recovery
- printed device label / device key QR for pairing

## 11. Software Implementation Stages

### Stage 1: Lean v1 Contracts

- define the device capability schema
- define the local event protocol
- define minimal output intents
- avoid persona-pack work in this stage

### Stage 2: Lean v1 Master Gateway

- add one-device WebSocket transport
- add simple local auth and device registry
- add health, connection, and privacy state
- ingest mic chunks and device status events

### Stage 3: Lean v1 Interaction Loop

- connect wake/state events to the existing voice path
- honor `wake_word_only`, `do_not_interrupt`, and privacy state
- send subtitle, face, and status events back to the device
- keep the first loop explicitly user-invoked, not proactive

### Stage 4: Lean v1 Provisioning And UX

- add local pairing and recovery flow
- add a simple device panel in LokiDoki
- surface device state, privacy state, and connection health

### Stage 5: Platform Expansion

- persona-pack upgrade
- deeper presence integration
- optional camera path
- richer embodiment rendering
- optional device-side audio playback choices

### Stage 6: Platform Hardening

- add room-level arbitration across devices
- add cooldowns and anti-chatter logic
- add failure modes, reconnect, degraded operation, and soak testing

## 12. Risks And Mitigations

### Risk: Too Much Device Complexity Too Early

Mitigation:

- keep the first embodied version display + mic + status focused
- defer motors, servos, and complex motion

### Risk: Presence Becomes Creepy Or Noisy

Mitigation:

- ship conservative defaults
- require explicit opt-in for proactive behavior
- surface explanations for ambient actions

### Risk: Pi Performance Regressions

Mitigation:

- keep presence loops lightweight
- keep camera analysis optional
- require graceful `pi_cpu` fallback for every `pi_hailo` optimization

## 13. Recommended Repo Shape

- `docs/companion-device-master-service/`
  - `DESIGN.md`
  - `PLAN.md`
  - chunk docs
- `lokidoki/device_gateway/`
- `lokidoki/embodiment/`
- `lokidoki/presence/`
- `lokidoki/persona_packs/`
- `frontend/src/components/devices/`

## 14. Non-Goals

- Docker-first deployment
- cloud LLM/TTS/STT providers
- splitting the assistant brain across bots
- storing raw continuous sensor archives by default
- introducing a second launch path outside `run.sh` / `run.bat`
