# LokiDoki Presence And Companion Intelligence Enhancement Design

## 1. Goal

This document defines how LokiDoki should evolve from a strong local assistant into a stronger ambient companion system with better presence, proactivity, social awareness, and trust. It covers:

- Features we enhance from the current design.
- Features we add that do not exist today.
- The technical design required to implement each item.
- A delivery order that preserves LokiDoki's core constraints:
  local-first runtime, profile-driven behavior, bootstrap-only installs,
  plugin boundaries, and offline-first operation after setup.

This document is an internal product and architecture design for LokiDoki only.

## 2. Product Direction

LokiDoki should compete on four pillars:

1. Private household intelligence.
2. Offline-first trustworthiness.
3. Companion-grade memory and personality continuity.
4. Ambient presence without requiring cloud dependence.

The key strategic move is not to imitate a toy robot category. The key move is
to make LokiDoki feel alive, attentive, and useful across voice, screen, room
context, and future embodiment layers while keeping the core brain local and
inspectable.

## 3. Current Baseline

Based on `docs/DESIGN.md` and the current codebase, LokiDoki already has:

- Local FastAPI control plane and React UI.
- Profile-driven model/runtime selection in `lokidoki/core/platform.py`.
- Offline-first maps and archive surfaces.
- A layered memory architecture with episodic, semantic, social, affective, and
  procedural tiers.
- Local STT, TTS, wake word, and resident-model policy.
- Multi-skill orchestration, routing, and synthesis.
- Admin controls, users, characters, and memory inspection.

What is still missing is a first-class presence loop that can observe,
interpret, decide, and express continuously rather than only responding to a
single request/response turn.

## 4. Design Principles

- Preserve offline-first runtime as the default contract.
- Keep all platform behavior profile-driven: `mac`, `pi_cpu`, `pi_hailo`.
- Treat sensing, memory, and expression as separate modules with explicit APIs.
- Prefer deterministic control loops around local models instead of giant,
  opaque end-to-end prompts.
- Keep embodiment optional. LokiDoki must work well as a non-robot local
  assistant and gain capabilities when sensors or output hardware are present.
- Make privacy legible in the UI and device behavior, not just in docs.
- Store inspectable structured state whenever possible.
- Make companion behavior optional. LokiDoki must support a quiet, utilitarian,
  low-disruption mode as a first-class experience.

## 4.1 Character, Mode, And Policy Separation

LokiDoki should not force users into a companion-style experience. Some users
will want warmth and personality only in casual contexts. Some will want a
strictly utilitarian assistant during focused periods. Some will want no
character styling at all. Some will want LokiDoki to respond only when
explicitly prompted.

To support this cleanly, the design must separate:

- `character_profile`
- `interaction_mode`
- `focus_policy`
- `schedule_policy`
- `interaction_policy`

These are not the same concept.

### Character Profile

Defines the stable identity layer:

- baseline tone
- preferred phrasing style
- warmth/playfulness defaults
- voice defaults
- default initiative preference

### Interaction Mode

Defines how LokiDoki should feel right now:

- `minimal`
- `utility`
- `balanced`
- `companion`

This is the user-facing behavior mode, not the character itself. It should
exist as both:

- a persistent user preference
- a temporary session override

### Focus Policy

Defines whether LokiDoki is allowed to be expressive or proactive in the
current context:

- `normal`
- `work`
- `meeting`
- `quiet_hours`
- `do_not_disturb`
- `sleep`

### Schedule Policy

Defines automatic switching rules:

- fixed no-disruption windows
- bedtime windows
- calendar-driven focus periods
- recurring user-defined quiet windows

### Interaction Policy

Defines how LokiDoki is allowed to engage at all:

- `open`
- `wake_word_only`
- `push_to_talk_only`
- `explicit_ui_only`
- `scheduled_quiet`
- `do_not_interrupt`

This is separate from tone and character. A user may keep the same selected
character while requiring LokiDoki to engage only after a wake word or an
explicit button press.

### Effective Behavior Resolution

Effective behavior should be computed as:

`character_profile -> interaction_mode -> focus_policy -> schedule_policy -> interaction_policy -> per-session override`

This ensures the same character can remain selected while becoming nearly
invisible or fully utilitarian during work, meetings, or other focused periods.

Examples:

- Same character, `companion` mode after work, `utility` mode during work.
- Same character, but flattened to neutral tone during meetings.
- No character styling at all by using `minimal` mode as the user's default.
- Same character, but only speaks after wake word in `wake_word_only` mode.
- User keeps `utility` as the default, then temporarily switches to
  `companion` for one evening conversation.

## 5. Features We Enhance

### 5.1 Enhance Memory Into A Salience And Forgetting System

#### Why

The current memory model is already sophisticated, but it is still oriented
around retrieval correctness. To feel companion-grade, memory also needs:

- salience
- routine detection
- memory compression
- natural forgetting
- explicit user-facing trust controls

#### Target Behavior

- Important user facts stay durable.
- Repetitive low-value details decay naturally.
- Memorable moments become compact life-event summaries.
- The system can explain why a memory was recalled.
- The user can inspect, pin, demote, or forget memories directly.

#### Technical Design

Add a memory salience layer in `lokidoki/orchestrator/memory/`:

- `salience.py`
  - Computes `salience_score` from recurrence, recency, explicit importance,
    emotional intensity, correction signals, and skill references.
- `consolidation.py`
  - Promotes raw observations into summaries, routines, or durable facts.
- `forgetting.py`
  - Applies scheduled decay by tier and category.

Schema additions to the main SQLite DB:

- `facts.salience_score REAL NOT NULL DEFAULT 0`
- `facts.pinned INTEGER NOT NULL DEFAULT 0`
- `facts.explain_json TEXT NULL`
- `episodes.salience_score REAL NOT NULL DEFAULT 0`
- `episodes.compacted_from_json TEXT NULL`
- new table `routines`
  - `id`
  - `user_id`
  - `pattern_key`
  - `description`
  - `confidence`
  - `time_window_json`
  - `trigger_json`
  - `last_seen_at`

Reader changes:

- Retrieval ranking becomes:
  `hybrid_relevance + salience_boost + recency_adjustment - contradiction_penalty`
- Add optional `memory_recall_explanations` to the request context for dev/admin
  surfaces and future user-facing trust views.

Writer changes:

- Explicit remember commands set a salience floor.
- Corrections lower old-memory salience and mark supersession.
- Emotional turns can boost episodic salience without promoting raw text.

UI changes:

- Memory tab gains `Pin`, `Demote`, `Forget`, and `Why recalled?`.
- Admin memory inspector surfaces salience and consolidation source.

Testing:

- Add unit tests for salience scoring and decay.
- Add conversation scripts covering recurrence, contradiction, routine learning,
  and emotionally salient events.

### 5.2 Enhance Voice From Turn-Based Audio To Full Duplex Conversation

#### Why

Current voice design is strong for local STT/TTS, but companion-grade behavior
requires more natural interruption, backchannels, and speaking-state awareness.

#### Target Behavior

- The user can interrupt naturally.
- LokiDoki can stop speaking when the user starts.
- LokiDoki can produce brief acknowledgements without full synthesis.
- Voice interactions feel less like walkie-talkie turns.

#### Technical Design

Add a full-duplex voice session manager:

- `lokidoki/audio/session.py`
- `lokidoki/audio/vad.py`
- `lokidoki/audio/barge_in.py`
- `lokidoki/audio/backchannel.py`

Core state machine:

- `idle`
- `listening`
- `thinking`
- `speaking`
- `barge_in_detected`
- `handoff_pause`

Pipeline changes:

- Run low-latency VAD continuously during TTS playback.
- If user speech exceeds threshold, send `barge_in` event to the response
  stream and cancel the remaining TTS segments.
- Add lightweight acknowledgement templates for cases like:
  - `"mm-hm"`
  - `"one second"`
  - `"got it"`
  - silent stop

STT changes:

- Keep the existing provider-swappable STT contract.
- Add streaming partial transcript support with timestamps and confidence.

TTS changes:

- Keep Piper as the core runtime TTS.
- Add segment priorities:
  - `full_response`
  - `short_ack`
  - `urgent_interruptible`

Frontend changes:

- Show listening/speaking/interrupted state in chat and voice surfaces.
- Visualize interrupted utterances distinctly in the timeline.

Testing:

- Integration tests for barge-in while speaking.
- Latency budget tests for ack response path.

### 5.3 Enhance Characters Into Persistent Companion Profiles

#### Why

Current character support exists, but companion-grade experience needs stronger
continuity across tone, style, routines, and affect.

#### Target Behavior

- Each character feels stable over time.
- Characters share factual memory correctly where appropriate.
- Emotional overlays differ by character.
- Users can tune boundaries and interaction style per character.
- Users can keep a character selected while suppressing most or all character
  styling during work, focus, or quiet periods.

#### Technical Design

Extend the current character model with:

- `base_temperament_json`
- `interaction_rules_json`
- `proactivity_policy_json`
- `voice_style_json`
- `idle_expression_policy_json`
- `style_floor`
- `style_ceiling`
- `allowed_interaction_modes_json`
- `work_hours_behavior_json`
- `focus_override_behavior_json`

Behavior layering:

- global user facts remain character-agnostic
- affective overlays remain character-scoped
- procedural routines gain both:
  - `global_routine`
  - `character_specific_routine`

Character system rule:

- character identity must never force companion behavior
- character traits are defaults, not hard requirements
- focus and schedule policy may flatten or suppress character expression
- `minimal` mode may reduce character output to nearly neutral utility speech
  while preserving the selected character internally

Prompt builder changes:

- Add compact character trait slots instead of long freeform text.
- Traits should map to structured knobs:
  - verbosity
  - warmth
  - playfulness
  - assertiveness
  - initiative tolerance
- Add effective-mode knobs:
  - `expressiveness_level`
  - `proactivity_allowed`
  - `response_briefness`
  - `character_styling_enabled`
  - `idle_behavior_enabled`

Admin UX:

- Add per-character tuning panels.
- Add preview/test prompt surface for character behavior.

### 5.4 Enhance Skill Orchestration Into Ambient Assistance

#### Why

The current router is request-centric. To feel more alive, LokiDoki needs a
decision layer that can choose not only how to answer but whether to act.

#### Target Behavior

- LokiDoki can choose between silent observation, a subtle cue, a question, or
  a full response.
- Skills can be invoked proactively when context supports them.
- The system stays conservative and avoids annoying interruptions.

#### Technical Design

Add an ambient decision layer after sensing and before skill execution:

- `lokidoki/orchestrator/ambient/ask.py`
- `lokidoki/orchestrator/ambient/policy.py`
- `lokidoki/orchestrator/ambient/act.py`

New decision output shape:

- `should_act: bool`
- `action_mode: silent | cue | ask | speak | skill_only`
- `reason_code`
- `confidence`
- `urgency`
- `cooldown_key`

Policy inputs:

- current user activity
- conversation state
- recent interruptions
- focus mode / quiet hours
- affect context
- routine triggers
- device state

Rules:

- deterministic guardrails decide if proactivity is even allowed
- local model may rank action options only after guardrails pass

Example proactive triggers:

- posture reminder after prolonged screen focus
- check-in after repeated negative affect signals
- bedtime routine at learned time window
- reminder follow-through

## 6. Features We Add

### 6.1 Add A Presence Loop

#### Why

This is the biggest missing system. LokiDoki needs a loop that runs
continuously and manages room awareness, attention, and idle behavior.

#### Target Behavior

- LokiDoki maintains a lightweight understanding of who is present, what mode
  the room is in, and whether it should do anything.
- It feels attentive even when it says nothing.

#### Technical Design

Create a new subsystem:

- `lokidoki/presence/`
  - `loop.py`
  - `state.py`
  - `attention.py`
  - `privacy.py`
  - `cooldowns.py`

Core loop cadence:

- low-frequency idle loop: every 2-5 seconds
- high-frequency local reflex loop when audio/vision events arrive

State model:

- `room_occupancy`
- `attention_target`
- `conversation_mode`
- `privacy_mode`
- `idle_mood`
- `engagement_level`

Inputs:

- wake word engine
- VAD
- optional camera/vision events
- UI activity
- device schedule
- memory/routine signals

Outputs:

- no-op
- UI status update
- short cue
- prompt to orchestrator
- privacy state change

Persistence:

- only structured summaries, no raw continuous sensor logs by default

### 6.2 Add Social Awareness And Multi-Person Conversation

#### Why

A home assistant that cannot model who is speaking to whom will interrupt at
the wrong time and feel clumsy.

#### Target Behavior

- LokiDoki can tell whether speech is directed at it.
- It can track multiple nearby people.
- It stays quiet during human-to-human exchanges unless invited in.

#### Technical Design

Add `social_context` as a first-class structured subsystem:

- `lokidoki/presence/social.py`
- `lokidoki/presence/participants.py`

Data model:

- `participants[]`
  - `participant_id`
  - `source: voice | face | known_person | unknown_person`
  - `attention_score`
  - `speaker_activity`
  - `is_addressing_assistant`
- `conversation_bubble`
  - `human_human`
  - `human_assistant`
  - `mixed`
  - `uncertain`

Implementation path:

1. Audio-first version
   - speaker diarization / turn segmentation
   - direct-address cues from wake word, assistant name, imperative phrasing,
     and microphone direction
2. Vision-assisted version
   - optional face presence and gaze hints
   - do not require face recognition to ship v1
3. Identity-linked version
   - tie known participants to social memory when confidence is high

Important constraint:

- Do not use regex/keyword heuristics for user intent classification.
- It is acceptable to use narrow deterministic cues for direct-address and
  audio routing because this is machine-state interpretation, not semantic
  meaning classification.
- If richer branching is needed, add structured decomposition fields.

### 6.3 Add Affective State Engine

#### Why

The current affective memory tracks sentiment over time, but LokiDoki lacks a
real-time affect model that can shape response timing, tone, and initiative.

#### Target Behavior

- LokiDoki maintains a lightweight real-time emotional stance.
- Its voice, initiative, and wording adapt smoothly.
- Emotional response is coherent across turns.

#### Technical Design

Add `affect_engine`:

- `lokidoki/affect/model.py`
- `lokidoki/affect/infer.py`
- `lokidoki/affect/express.py`

Internal representation:

- use a continuous vector, not discrete labels
- initial shape:
  - `valence`
  - `arousal`
  - `confidence`
  - `engagement`

Inputs:

- decomposer sentiment output
- prosody features from voice input
- conversation success/failure markers
- recent memory context

Outputs:

- synthesis style knobs
- proactivity sensitivity
- acknowledgement style
- idle cue selection

Storage:

- short-lived state stays in memory
- periodic summaries write into Tier 6 affective memory

### 6.4 Add Privacy State And Legible Sensor Controls

#### Why

Trust cannot rely only on policy text. LokiDoki needs visible privacy modes and
 predictable sensor behavior.

#### Target Behavior

- The user always knows when sensing is active.
- Quiet mode and privacy mode are easy to trigger.
- Context-sensitive discretion works locally.

#### Technical Design

Add privacy states:

- `open`
- `quiet`
- `do_not_watch`
- `do_not_listen`
- `sleep`

Subsystem:

- `lokidoki/presence/privacy.py`

UI changes:

- persistent privacy indicator in chat shell and settings
- quick actions for:
  - Sleep
  - Mute mic
  - Disable camera
  - Quiet hours
- add behavior-mode quick actions:
  - Minimal mode
  - Utility mode
  - Companion mode
  - Work focus
  - Meeting mode

Backend changes:

- all sensing subsystems must consult a central privacy state provider
- privacy state stored per device and per user where relevant
- audit event stream stores privacy state changes only, not raw media
- focus-policy state must be readable by the presence loop, ambient policy
  layer, TTS behavior selector, and prompt builder

Bootstrap and offline constraints:

- no cloud privacy dependency
- all privacy enforcement local

### 6.5 Add Embodiment Abstraction Layer

#### Why

LokiDoki should be able to support future hardware shells, screens, lights, or
 motion systems without coupling the core assistant to one specific device.

#### Target Behavior

- The same core brain can drive:
  - pure screen UI
  - voice-only unit
  - desktop animated shell
  - future plush or robotic housing

#### Technical Design

Create `lokidoki/embodiment/`:

- `driver.py`
- `events.py`
- `capabilities.py`
- `simulator.py`

Capability contract:

- `can_gaze`
- `can_light`
- `can_move`
- `can_touch`
- `can_show_face`
- `can_show_privacy_state`

Output primitives:

- `look_at(target)`
- `set_idle_state(state)`
- `show_privacy_state(state)`
- `emit_ack(kind)`
- `perform_expression(name, intensity, duration)`

The core orchestrator emits abstract expression events. Device-specific drivers
map them to hardware. On `mac` and generic desktop builds, the embodiment
simulator renders the same events in the UI.

### 6.6 Add Routine Learning And Follow-Through

#### Why

Companionship improves when the system remembers habits and helps gently over
time.

#### Target Behavior

- LokiDoki learns recurring schedules and check-in patterns.
- It can suggest and run routines with consent.
- Follow-through persists across sessions.

#### Technical Design

Use the new `routines` table plus a scheduler subsystem:

- `lokidoki/routines/infer.py`
- `lokidoki/routines/scheduler.py`
- `lokidoki/routines/execute.py`

Routine sources:

- repeated manual reminders
- repeated session times
- repeated skill sequences
- explicit user commands

Execution rules:

- all proactive routines require:
  - user opt-in
  - cooldowns
  - clear disable path

Frontend:

- routine cards in settings and memory surfaces
- user can approve, snooze, edit, or disable

### 6.8 Add Focus Modes And Flexible Interaction Policies

#### Why

Presence and proactivity only help if users can reliably suppress them. LokiDoki
needs a strong non-disruption model for focused work, meetings, custom quiet
windows, and any period where personality or initiative would be unwelcome.
It also needs explicit interaction gating for users who only want responses
after direct prompts such as wake word, push-to-talk, or UI action.

#### Target Behavior

- Users can choose `minimal` or `utility` behavior as a default.
- Users can set a persistent preferred interaction style.
- Users can temporarily switch interaction style without changing their saved
  default.
- Users can define fixed no-disruption windows, but they are not required.
- Calendar or manual focus state can suppress playful or companion-like output.
- Users can require explicit invocation, such as wake-word-only behavior.
- Users can combine schedule rules and invocation rules.
- During focus periods, LokiDoki only interrupts for urgent or explicitly
  allowed categories.

#### Technical Design

Add a focus-mode subsystem:

- `lokidoki/presence/focus.py`
- `lokidoki/presence/schedule.py`
- `lokidoki/presence/interaction_policy.py`

User-configurable modes:

- `minimal`
- `utility`
- `balanced`
- `companion`

Focus states:

- `normal`
- `work`
- `meeting`
- `quiet_hours`
- `do_not_disturb`

Interaction gates:

- `open`
- `wake_word_only`
- `push_to_talk_only`
- `explicit_ui_only`
- `scheduled_quiet`
- `do_not_interrupt`

New user-profile fields:

- `default_interaction_mode`
- `preferred_interaction_style`
- `no_disruption_windows_json`
- `quiet_hours_json`
- `calendar_focus_enabled`
- `default_interaction_gate`
- `allow_proactive_in_focus`
- `allow_character_styling_in_focus`
- `allow_nonurgent_interruptions`
- `allow_wake_word_during_quiet`
- `allow_push_to_talk_during_quiet`
- `calendar_policy_json`
- `manual_override_until`

Session/runtime fields:

- `temporary_interaction_mode`
- `temporary_interaction_gate`
- `temporary_override_reason`
- `temporary_override_expires_at`

Effective behavior knobs resolved per turn:

- `max_response_length`
- `tone_style`
- `proactivity_allowed`
- `idle_behavior_allowed`
- `character_styling_enabled`
- `emotion_mirroring_enabled`
- `interruption_threshold`
- `invocation_required`
- `allowed_input_paths`
- `wake_word_enabled`
- `ambient_initiation_allowed`

Enforcement points:

- presence loop decides whether it may initiate
- ambient decision layer may only emit allowed action modes
- prompt builder receives compact style/focus knobs
- TTS selector chooses neutral or expressive delivery
- frontend suppresses decorative/idle expression events in `minimal` and
  `utility` modes
- audio pipeline checks whether open-mic engagement is allowed or whether a
  wake word / push-to-talk gate must be satisfied before routing the turn
- wake word subsystem can remain enabled even when proactive behavior is
  disabled, depending on user policy

Priority rule:

- `do_not_disturb` overrides all character defaults
- `meeting` overrides playful and proactive behavior
- `work` defaults to concise, neutral, utility-first behavior unless user opts
  into more personality
- `wake_word_only` disables ambient initiation and direct-address pickup
  without an explicit wake word event
- `push_to_talk_only` disables open-mic turn starts outside the UI/audio press
  path
- temporary per-session override outranks schedule until cleared or expired
- persistent user preference is the baseline when no temporary override is
  active

UI changes:

- add a focus-mode picker in the main shell
- add interaction-gate controls in the main shell and settings
- add flexible no-disruption windows in settings
- add a persistent preferred-interaction-style setting in the user profile
- add quick temporary toggles such as:
  - `Be more companion-like for now`
  - `Be brief for now`
  - `Do not interrupt me for now`
  - `Wake word only for now`
- show the active effective mode in the UI so behavior changes are legible
- show whether LokiDoki is currently `open`, `wake_word_only`,
  `push_to_talk_only`, or `do_not_interrupt`
- show when a temporary override is active and when it expires or how to clear
  it

Testing:

- unit tests for policy resolution
- integration tests for automatic schedule switching and manual overrides
- integration tests for wake-word-only and push-to-talk-only behavior
- integration tests for temporary interaction-style overrides and expiry
- conversation tests ensuring the same character responds differently in
  `companion` vs `utility` vs `minimal` mode

### 6.7 Add Companion Developer Surface

#### Why

If LokiDoki is going to support richer presence and ambient behaviors, plugin
authors need a safe API for them.

#### Target Behavior

- Plugins can declare proactive triggers and companion-safe outputs.
- Core safety and privacy policy still decide whether they may run.

#### Technical Design

Extend plugin capability schema with:

- `supports_proactive: bool`
- `required_context: []`
- `allowed_action_modes: []`
- `privacy_level`
- `cooldown_policy`

Add a core `companion_action` envelope:

- `title`
- `summary`
- `action_mode`
- `requires_confirmation`
- `cooldown_key`
- `safety_tags`

Only core-approved action modes can trigger ambient behaviors.

## 7. Cross-Cutting Architecture Changes

### 7.1 New High-Level Runtime Flow

Current:

```text
[STT] -> [Classifier] -> [Router] -> [Skill Handlers | fast Qwen | thinking Qwen] -> [TTS]
```

Target:

```text
[Sensors/UI]
    -> [Presence Loop]
    -> [Privacy Gate]
    -> [Social Context]
    -> [Affect Engine]
    -> [Ambient Decision Layer]
    -> [Classifier / Router / Skills / LLM]
    -> [Expression Layer]
    -> [TTS/UI/Embodiment]
```

### 7.2 New Structured Context Objects

Add to request/session context:

- `presence_state`
- `social_context`
- `affect_state`
- `privacy_state`
- `focus_state`
- `routine_context`
- `ambient_policy`
- `interaction_mode`
- `effective_behavior`

These should be compact dataclasses or Pydantic models, not loose dicts.

### 7.3 Streaming Events

Add new SSE event types:

- `presence_update`
- `privacy_state_changed`
- `barge_in`
- `ambient_decision`
- `expression_event`
- `routine_suggestion`

## 8. Delivery Order

### Phase A: Trust And Foundations

- Privacy state provider
- Salience scoring
- Memory explainability
- Full-duplex voice session manager

### Phase B: Presence Core

- Presence loop
- Ambient decision layer
- Affective state engine
- UI simulator for expressions

### Phase C: Social And Routine Intelligence

- Multi-person audio-first conversation modeling
- Routine learning
- Proactive reminders and check-ins

### Phase D: Optional Embodiment

- Embodiment abstraction layer
- Device simulator
- Hardware driver interfaces

### Phase E: Ecosystem

- Plugin schema extensions
- Companion-safe proactive plugin surface

## 9. Gaps, Risks, And Mitigations

### Risk: Overactive Proactivity

Mitigation:

- global cooldowns
- quiet hours
- per-user proactivity tolerance
- action-mode policies with conservative defaults

### Risk: Sensor Creep Violates Trust

Mitigation:

- privacy state is visible and local-first
- no raw media retention by default
- structured summaries only
- explicit settings and audit trail

### Risk: Pi Performance Regressions

Mitigation:

- keep the presence loop lightweight
- split fast local reflexes from heavier reasoning
- use profile-driven feature downgrades on `pi_cpu`
- enforce char/token budgets for all added prompt slots

### Risk: Memory Becomes Unpredictable

Mitigation:

- deterministic salience inputs
- admin/user explainability
- strong regression corpus for recall and forgetting

## 10. Success Metrics

- Users interrupt LokiDoki successfully without awkward overlap.
- The system chooses silence correctly in multi-person settings.
- Memory recall feels more relevant and less cluttered.
- Proactive behaviors are accepted more often than dismissed.
- Privacy controls are discoverable and trusted.
- The same core assistant can run on macOS, Pi CPU, and Pi Hailo without
  architecture forks.

## 11. Recommended Next Docs

This document should feed follow-on chunked plans for:

- `docs/presence_loop/`
- `docs/full_duplex_voice/`
- `docs/memory_salience/`
- `docs/social_context/`
- `docs/embodiment_layer/`

Those plans should follow the repository chunk pattern and execute one chunk per
session.
