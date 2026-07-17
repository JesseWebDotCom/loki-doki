# Command intelligence & routing plan

*Drafted 2026-07-17. Source: three-track codebase audit (routing pipeline, Home Assistant
integration, volume/media control paths). Companion to
[interpretation-and-presentation-plan.md](./interpretation-and-presentation-plan.md) — that doc
upgrades **how the router reasons**; this one upgrades **what commands can target and how targets
are resolved**. The two are orthogonal and sequenced independently; the one interlock is called out
in "Interplay" at the bottom.*

## Problem statement

Three user-visible failures motivated the audit, with root causes confirmed in code:

1. **"Lower the volume" never touches the music that's playing.** The router's only volume-capable
   tool is `homeAssistant` (`backend/src/llm/router.ts:176`); the Doki Dock's own radio-engine gain
   (`frontend/src/lib/music/radioEngine.ts:1093`) has no voice path at all — slider only. With HA
   unconfigured the command errors instead of dimming the local music. No code anywhere arbitrates
   local-vs-HA media targets; the split is an accident of router tool selection.
2. **No room context.** The speaking device contributes nothing to resolution: pods pass
   `uiContext: null` and `surface: 'pod'` ("affects logging only") into the turn
   (`backend/src/lib/pod/brain.ts:39-51`). "Turn off the lights" from a bedroom pod has no bedroom
   default; every command must name its room. This is the root cause behind most "dumb" behavior,
   including the multi-fan and multi-zone-thermostat cases.
3. **Implicit cues are unhandled by design.** "It's hot in here" / "it's cold" / "it's dark" /
   "that's too loud" match no fast-path, no HA tool example (`backend/src/tools/homeAssistant.ts:69-71`
   are all imperatives), and no action verb in `detectAction`
   (`backend/src/lib/homeAssistant/resolve.ts:65-115`). Likely routings today: the *outdoor weather*
   tool ("hot" ≈ weather examples, and the tier-2 rule pushes there) or the conversational absorber
   (sympathy, no action). The imperative equivalents all work ("make it warmer" → +2°,
   `resolve.ts:109`); the system has no concept of inferring a command from a stated discomfort.

What already works and must not regress:

- Ambiguous device targets **fail closed**: 3 fans + no room → `unknown` → scoped LLM fallback →
  "name the room and device" (`resolve.ts:223-242`, `homeAssistant/index.ts:99-111`). No
  first-match-wins actuation bug exists.
- media_player is fully controllable via HA — volume set/up/down, mute, transport
  (`backend/src/lib/homeAssistant/actions.ts:58-67`).
- Area awareness is real where the user speaks it: HA areas are synced over WebSocket and matched by
  name (`sync.ts:285-286`, `resolve.ts:150-160`); grants are per-(domain, area); security actions
  stage a confirmation (`index.ts:124-144`).

## Design principles

- **Room context is the highest-leverage missing input.** Most ambiguity dissolves once "here" has a
  value. It lands before the clever stuff.
- **Commands actuate; cues propose.** An imperative ("turn on the fan") acts immediately when
  unambiguous. A cue ("it's hot in here") is a hint — ground it in sensor state and confirm before
  acting, reusing the existing confirm flow.
- **Fail closed stays.** New resolution layers may *narrow* candidates, never guess across rooms.
- **Deterministic first, LLM last** — same shape the HA resolver already has. Every phase here ships
  a deterministic version that works on the 8B-local-model latency budget; the model-side loop from
  the interpretation plan can absorb the reasoning later without redoing the plumbing.

---

## Phase A — Bugs and capability gaps (independently shippable, low risk)

**A1. Controller Vol +/− buttons are dead (confirmed bug).** The built-in controller template emits
`app_action: volume_up/down` (`backend/src/lib/pod/controllerStudio.ts:249-250`; same options in
`frontend/src/components/shared/DeviceScreenDeckEditor.tsx:406-407`), dispatch passes them through
(`backend/src/lib/pod/controllerActions.ts:44-46`), but the frontend handler has no volume case
(`frontend/src/hooks/useBrowserSession.ts:79-108`) — presses silently no-op. Fix: add
`volume_up`/`volume_down`/`mute` to `mediaCoordinator.dispatchTransport`
(`frontend/src/lib/mediaCoordinator.ts:64-72`, which today handles transport but not volume) driving
whichever engine is active, and handle the actions in `useBrowserSession`. This also creates the
local-volume primitive Phase C needs.

**A2. Fan speed.** Fan domain is on/off/toggle only (`actions.ts:24`) despite `percentage` being
surfaced read-only (`backend/src/routes/homeAssistant.ts:41-43`). Add `set_percentage` →
`fan.set_percentage {percentage}` (plus optional `oscillate`, preset modes later), wire the existing
pct extraction in `detectAction` (it already parses "50%") to fans, and extend the entity-route
action validation. "Set the fan to 50" works after this.

**A3. Light color and color temperature.** Only `brightness_pct` maps today (`actions.ts:52-53`).
Add `light.turn_on` with `color_temp_kelvin` ("warmer"/"cooler light", "2700K") and named colors
(`color_name` / `rgb_color`). Phrase detection in `detectAction`: "make the lights warmer" must be
disambiguated from climate — rule: warmth words + a light-domain keyword → light color temp;
otherwise climate keeps it.

**A4. Import HA aliases; optionally respect Assist exposure.** Sync currently keeps only
`friendly_name` (`backend/src/lib/homeAssistant/sync.ts:363-366`); HA's per-entity spoken aliases
are in the entity registry we already pull — store them and include in `matchByName`/`narrowByName`.
Separately, capture the `options.conversation.should_expose` flag and add an admin toggle "respect
HA Assist exposure" (default off, since our grant model is the primary gate — but a device hidden
from HA's own assistant being controllable here surprised the audit).

**A5. Small correctness items.**
- `set_temperature` accepted without a value in the LLM-fallback path would build a service call
  with `temperature: undefined` — validate action-specific required values in `llmResolve`'s
  post-parse (`homeAssistant/index.ts:225-240`) and in `buildServiceCalls`.
- Tool id/name mismatch `time` vs `alarms_timers` (`router.ts:169`, `tools/index.ts:233`) — rename
  to match; latent footgun.
- Multi-intent dedup by tool id (`router.ts:674-679`) collapses "kitchen lights off and bedroom
  lights off" to one call — dedup by (tool, args-hash) instead.
- Multi-zone thermostat: area-less "set thermostat to 72" targets ALL climate zones
  (`resolve.ts:219-222`). Keep for single-zone homes; when >1 zone exists, prefer the origin area
  (Phase B) and, absent that, confirm instead of blasting all zones.

## Phase B — Room context: device→area binding (the root fix)

Give every command an **origin area** so "here" and bare-domain commands resolve like a human
expects.

**B1. Bind devices to HA areas.** Add `areaId` (nullable, an HA area id) to the pod/device
descriptor (`backend/src/lib/pod/deviceStudio.ts` schema) and to dock browser-session registration
(`useBrowserSession` / `routes/browserSession.ts` — per-machine setting on the Doki Dock). Admin UI:
an area picker in Device Studio fed by the synced area registry. Devices sync areas from HA; no
parallel room model.

**B2. Thread origin through the turn.** `satelliteSession` → `runPodBrain` `buildTurnParams`
(`brain.ts:39-51`, today `uiContext: null`) → new `originAreaId` param on `runCompanionTurn` →
tool config → `handleCommand` → `deterministicResolve(message, entities, areas, originAreaId)`.
Same threading from dock browser sessions via the chat route.

**B3. Resolution semantics** (amend `resolve.ts:188-265`):
1. An explicitly spoken area always wins (unchanged).
2. "here / in here / this room" → origin area; error with a helpful message if the device is unbound.
3. Bare domain + multiple candidates (today's ambiguous → LLM path): if the origin area contains
   entities of that domain, scope to them first; only if *that* is still ambiguous, fall to the LLM /
   clarification. Bedroom pod + "turn off the lights" → bedroom lights.
4. No origin (plain browser tab, Telegram): behavior unchanged.
5. Multi-zone thermostat prefers the origin-area zone (closes A5's confirm case for bound devices).

Fail-closed is preserved: origin narrows candidates, never crosses rooms.

## Phase C — Media target arbitration (local vs HA)

A spoken volume/transport command should affect **what is actually playing near the speaker**, in
priority order. Build an arbitrator in front of the HA tool's media path:

1. Extend the now-playing store (`backend/src/lib/pod/nowPlaying.ts`, per-user today) to record the
   **origin device/dock** of the active playback session.
2. New backend-triggered local volume: reuse `pushToBrowserSession` (as `controllerActions.ts:106`
   does) to send the A1 volume `app_action`s to the session that owns playback.
3. Arbitration for "lower the volume / pause / mute" (no device named):
   1. Active **local** playback session for this user/household (now-playing store) → adjust the
      local engine via browser command.
   2. Else an HA media_player in the **origin area** that is `playing` (live state is already in the
      WS-synced catalog) → target it.
   3. Else exactly one HA media_player playing anywhere → target it.
   4. Else → existing resolve path / clarification.
4. Explicitly named targets bypass arbitration ("mute the living room TV" behaves as today).
5. Out of scope for now: pod chime/TTS volume by voice (the `deviceSettings.ts:18` TODO) and
   multi-room audio zones — the latter is its own roadmap phase (see HA add-on roadmap).

Implementation seam: intercept in `backend/src/tools/homeAssistant.ts` before `handleCommand` when
the detected action is media volume/transport and no entity name matched — so the HA resolver stays
pure.

## Phase D — Implicit cues (comfort intents)

Translate "I'm uncomfortable on axis X" into a **grounded proposal** in the origin room.

**D1. Cue lexicon → (axis, direction).** Deterministic table, e.g.: hot/warm/stuffy/boiling → climate
cool; cold/chilly/freezing → climate warm; dark/dim/can't see → lights on-or-brighten; too
bright/glary → dim; too loud → volume down; can't hear it → volume up. Detection: a small `CUE_RE`
tier-0 fast-path (declarative, first/second person, no imperative verb) + cue phrasings added to the
HA tool's embedding `examples` so tier-1 stops routing "it's hot in here" to weather. Add negative
guards ("it's hot outside" stays weather; "that movie was dark" stays chat — require "in here / in
the X / it's … in" style locative or media-playing context for the loud/quiet cues).

**D2. Grounding before acting.** Resolve the target room (origin area, Phase B — cues without an
origin and without a spoken room fall back to single-candidate-or-clarify). Read live state from the
synced catalog: indoor temp from the room's climate/temperature sensor, light on/off+brightness,
what's playing. The reply cites reality: *"It's 76° in the office — drop the AC to 72?"*

**D3. Propose-then-confirm.** Cues route through the existing staged-confirmation flow
(`confirm_pending` directive, `homeAssistant/index.ts:124-144` pattern; the hands-free follow-up
window already holds open for a spoken "yes", `useHandsFree.ts:49`). This is a deliberate,
scoped exception to the router's "never ask a clarifying question" rule (`router.ts:197`): cues are
hints, not commands. Per-household setting `comfort_cues`: **off / suggest (default) / auto** —
auto skips confirmation for reversible actions only (never security domain, which stays staged).

**D4. Follow-through.** Confirmed cue action executes via the normal plan path (grants, security
carve-outs, and reply strings all apply unchanged). Declined → remember in the 180s HA context so
"actually yes, do it" works.

## Phase E — Clarification quality

Upgrade the canned ambiguity reply ("I couldn't tell which device you meant…",
`homeAssistant/index.ts:110`) into a real question listing the candidates — "the ceiling fan or the
desk fan?" — and stash the candidate set in the existing 180s HA conversation context
(`homeAssistant/context.ts`) so a short answer ("the desk one") resolves without repeating the
command. Voice reuses the hands-free follow-up window. This aligns with (and is later absorbed by)
the interpretation plan's Phase 3 unified follow-up state; the context-stash version ships without
waiting for it.

---

## Sequencing & risk

1. **A** first — self-contained fixes, each independently shippable; A1 is the only confirmed
   dead-feature bug and A1's coordinator work is a Phase C prerequisite.
2. **B** second — one schema field + param threading + ~30 lines of resolver logic; unlocks C and D.
   Risk: docks/pods misbound to the wrong area actuate the wrong room — mitigate with the resolver
   only *narrowing* (never overriding a spoken area) and an admin-visible binding.
3. **C** after A1+B. Risk: arbitration surprising the user (lowering dock music when they meant the
   TV) — mitigated by the playing-state checks and explicit names always bypassing.
4. **D** after B, behind the `comfort_cues` household setting (default *suggest*, never silent-auto
   at launch). **E** rides with D (shared context/confirm plumbing).
5. Nothing here blocks on the interpretation plan; see below.

## Interplay with interpretation-and-presentation-plan.md

- That plan's Phase 3 replaces tier-2 with a bounded model-side loop. Everything here is built as
  **data + deterministic resolution + one arbitration seam**, so when the loop lands, cue reasoning
  and clarification move into model decision rules while the lexicon, origin-area threading,
  grounding reads, and confirm flow are reused as-is.
- Its Phase 3 item 5 (unified follow-up state) eventually subsumes Phase E's context-stash; E is the
  cheap interim.
- Rules/examples added here (cue lexicon, new HA examples) go in the same externalized data file
  that plan proposes for `TIER2_RULES`, not new literals in `router.ts`.

## Verification

- **Router regression**: the existing router-index examples must keep routing correctly after new
  HA examples land (same eval the interpretation plan mandates); add cue phrases and volume phrases
  as new fixtures with expected tool + expected non-matches ("it's hot outside" → weather).
- **Resolver unit tests** (`deterministicResolve`): origin-area narrowing incl. fail-closed cases,
  "here" resolution, fan `set_percentage`, light color-temp vs climate disambiguation, multi-zone
  thermostat preference, alias matching.
- **Arbitrator unit tests**: preference ordering 1→4, explicit-name bypass, HA-unconfigured
  fallback to local.
- **End-to-end**: bedroom-pod scenarios (lights, fan, "it's hot in here" proposal + spoken "yes"),
  dock-playing-music + "lower the volume", controller Vol buttons on a physical device.
