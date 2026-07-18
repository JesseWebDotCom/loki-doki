# Apple AI Parity Review (July 2026)

Status: proposal reviewed and implemented. All seven phases landed on `main` on 2026-07-17
(commits prefixed `feat(ai-parity)`). Companion docs: `roadmap` memory (6-phase HA add-on plan),
`interpretation-presentation-plan.md`, `command-intelligence-plan.md`.

## Implementation status (2026-07-17)

- **P7 foundation (shipped):** `AiGeneratedBadge` shared component + Visual Language rules
  (label AI content, keep Edit/Undo/Retry adjacent, never summarize safety alerts).
- **P1 Writing Tools (shipped):** `WritingToolsPopover` + `POST /api/writing-tools` SSE route.
  Wired into the Note editor; component ready for Canvas and the composer (follow-up).
- **P2 Notification digest (shipped):** opt-in `/api/notifications/digest`, safety-excluded,
  cached, `AiGeneratedBadge` in the bell + a settings toggle.
- **P3 Clean Up (shipped):** SDXL `inpaint` pipeline + `buildInpaintWorkflow` + `CleanUpDialog`
  brush-mask editor in Imaging. Extend/outpaint and the Generate style-tile strip are follow-ups.
- **P4 Camera intelligence (shipped):** NL footage search (`/api/frigate/search`, lazy nomic
  embeddings on a new `frigate_events.embedding` column) + daily per-camera digest
  (`/api/frigate/digest`) on the Cameras page. Face recognition deferred (consent design).
- **P5 Translation (shipped):** `/translate` two-party app + `POST /api/translate/text`; Whisper
  in, local LLM, spoken out. Browser synthesizer covers languages Kokoro lacks; podcast
  translated-transcript quick win is a follow-up.
- **P6 Assistant polish (partial):** chat retention (month/year/forever) with a daily sweep +
  a new Settings > Local AI section (the "nothing leaves the house" report). Ask-from-Spotlight,
  semantic content index, and desktop screen-awareness are follow-ups (deeper chat/search work).

Below is the original proposal, kept for reference.

---


This reviews the AI feature set of current Apple platforms (iOS 26.5 / macOS 26 Tahoe stable,
plus everything announced at WWDC 2026 for iOS 27 / macOS 27 "Golden Gate", public beta since
July 13, 2026), compares it against Loki Doki, and proposes changes for feature and UI/UX
parity. All proposals stay inside our constraints: fully local models, no cloud LLMs, existing
stack (Ollama, Kokoro, Whisper, ComfyUI, shadcn/Tailwind).

## 1. Apple's current AI landscape, condensed

What matters for us, verified against Apple primary sources and press as of 2026-07-17:

- **Siri AI** (announced WWDC 2026, waitlisted iOS 27 beta only): rebuilt conversational
  assistant with personal context, on-screen awareness, cross-app actions, a dedicated chat
  app with synced history and retention controls (month/year/forever). Backend is Apple
  Foundation Models now built on Google Gemini, routed on-device, then Private Cloud Compute,
  then Google Cloud. Visual identity moved from the full-screen edge glow to a Dynamic
  Island-anchored dark chat surface with a glowing input cursor.
- **Writing Tools** (stable since iOS 18/26): system-wide select-text popover with proofread,
  rewrite (friendly/professional/concise), summarize, key points, list, table. Rewrites
  replace inline with an "Original" toggle. iOS 27 adds automatic proofreading and Smart
  Reply drafted in the user's own writing style.
- **Summarization**: notification summaries (italic + glyph + "Summarized by Apple
  Intelligence" label, opt-in per category with an accuracy warning for news), mail
  summaries and priority messages, Safari page summaries, voicemail/call summaries.
- **Image/creative**: Image Playground (style tiles, iOS 27 goes photorealistic with
  edit-by-description), Genmoji, Image Wand, Clean Up (object removal); iOS 27 adds
  outpainting ("Extend") and Spatial Reframing.
- **Visual Intelligence**: camera and on-screen (screenshot-chord) flows: identify,
  translate, extract events, search. iOS 27 folds it into Camera as a "Siri Mode".
- **Live Translation** (on-device): Messages auto-translate, FaceTime captions, Phone spoken
  translation, AirPods hands-free. iOS 27 adds system-wide translated video captions.
- **Search and platform**: macOS Spotlight runs App Intents actions; iOS 27 adds a semantic
  index apps can feed; Shortcuts has "Use Model" and iOS 27 "Describe a Shortcut" (build a
  shortcut from natural language); Safari "Notify Me" watches pages for changes.
- **Home**: nothing shipped. HomePad display delayed to fall 2026 waiting on Siri. The real
  substance is the iOS 27 Home app: AI camera activity summaries, person/animal/vehicle/
  package recognition, face recognition against the Photos library, natural-language search
  of recorded footage, noteworthy-clip surfacing. Some of it gated on a 2TB iCloud+ tier.
- **UX grammar (HIG "Generative AI")**: never pass AI off as human; keep Edit/Undo/Retry
  adjacent to generated content; confirm before acting on someone's behalf; specific status
  text over generic spinners; disclose server-side processing; label AI-generated summaries.

Strategic read: Apple's assistant is still in beta and their home story is unshipped and
cloud-gated. Our overlap areas (assistant + memory, camera AI, family profiles, local-only
privacy) are places we are ahead today. The gaps are polish surfaces: writing tools
everywhere, a consistent AI labeling grammar, photo clean-up, and live translation.

## 2. Scorecard: Apple feature vs Loki Doki

| Apple feature | Our status | Verdict |
|---|---|---|
| Siri AI assistant + personal context | Companion: 58 tools, sleep-time memory, notes/inventory RAG, synced conversations | **Ahead** (shipped vs their beta) |
| Siri on-screen awareness | Mobile quick-ask sheet is screen-aware; desktop is not | Partial |
| Dedicated assistant app + history retention controls | Chat app yes; no retention controls | Partial |
| Writing Tools (system-wide select-text) | Only chat-scoped Document Assistant + Canvas edit pass | **Gap** |
| Smart Reply / write-in-my-style | Absent | Gap (low priority) |
| Notification summaries + priority | Rule-based notifications only, no LLM triage | **Gap** |
| Mail/page/call summaries | Podcast insights, briefing, notes answers; no page-summary surface | Partial |
| Image Playground | Imaging app: SDXL gen/edit, styles, LoRAs, face identity, video gen | **Ahead** on power, behind on approachability |
| Clean Up (object removal) | Absent (no inpaint UI) | **Gap** |
| Extend (outpainting) | Absent | Gap |
| Genmoji | Absent (emoji banned as UI) | Non-goal |
| Visual Intelligence (camera/screen) | Vision analyze passes (objects, OCR, plates, safety) on Imaging page | Partial (no curated lookups, no in-place flows) |
| Live Translation (speech) | Batch text only (lyrics, captions, documents) | **Gap** |
| Translated video captions | Shipped (YouTube caption translation) | Parity |
| Photos NL search / footage search | Frigate events get VLM descriptions; no NL search over them | **Gap** (and our best "beat Apple" angle) |
| Spotlight actions + semantic index | SpotlightSearch is navigation-only | Gap |
| Shortcuts "Describe a Shortcut" | Routines engine exists; no NL builder | Gap (already on roadmap phase 3) |
| Safari "Notify Me" page watch | Absent | Gap (low priority) |
| Call Screening / Hold Assist | N/A (no telephony) | Non-goal |
| Apple Intelligence Report (privacy log) | Absent | Gap (cheap, high trust value) |
| HIG generative-AI grammar (labels, Edit/Undo/Retry, confirmations) | Confirmations yes; labeling inconsistent | Partial |
| Liquid Glass design language | Deliberately different (calm surfaces) | Non-goal |

## 3. Proposed changes

Ordered by leverage: user-visible value divided by effort, with our local-first advantage
weighted up. Phases are independently shippable.

### P1. Writing Tools everywhere (the biggest UX gap)

A system-wide analog of Apple's select-text popover, scoped to our app surfaces.

- New shared component `WritingToolsPopover` (Radix Popover, brand accent): appears from a
  small sparkle affordance when text is selected inside sanctioned editable surfaces (Notes
  editor, Canvas pane, chat composer, book authoring, routine descriptions) or via a
  toolbar button on read surfaces (news reader, Reference articles) for Summarize/Key Points.
- Actions mirror Apple's set and map 1:1 onto the existing `documentEdit` tool prompts
  (`backend/src/tools/documentEdit.ts`): Proofread, Rewrite (Friendly / Professional /
  Concise), Summarize, Key Points, Make List, Translate. Backend: one new route
  `POST /api/writing-tools` that reuses the documentEdit prompt library on a text selection
  instead of an uploaded document, streaming via SSE like the Canvas edit pass.
- Interaction parity: replace the selection inline, keep an "Original" chip to toggle back
  (store the pre-edit string client-side; no schema change). On phones, render as a bottom
  sheet instead of a popover (respects `--bottom-chrome`).
- Editable-surface integration is the main cost. Start with the two richest text surfaces
  (Notes, Canvas) and the composer, then spread.

### P2. Notification intelligence, with Apple's labeling grammar

- Per-user opt-in "Summarize notifications" preference. A small LLM pass (main `llm` role)
  collapses a burst of unread notifications into one digest line for the bell dropdown and
  Web Push/Telegram digests, and tags each notification with a priority
  (`time-sensitive | normal | quiet`).
- Adopt Apple's presentation rules exactly, since they were learned the hard way (BBC
  headline incident): summaries render in italic with a sparkle glyph and a "Summarized by
  Loki" label, opt-in per notification type, and safety-relevant types (Frigate camera
  alerts) are never summarized, always verbatim.
- Backend: extend `notifications` with `summary` + `priority` columns; summarization runs in
  the existing sweep/maintenance cadence, never on the hot path.

### P3. Clean Up and Extend in Imaging

- **Clean Up**: brush-to-erase object removal on the Imaging canvas. ComfyUI already runs
  our stack; add an SDXL inpainting workflow (`comfyWorkflows.ts`) taking image + user mask.
  UI: a "Clean Up" tool mode with an adjustable brush, mask overlay in `--brand` at 40%,
  same SSE step progress as generate/edit. This is Apple's single most-used photo AI feature
  and we have every ingredient except the workflow JSON and the brush layer.
- **Extend (outpainting)**: same workflow family, pad-and-fill with a direction picker.
  Lower priority than Clean Up; ship second within the same tool mode.
- While in there: add an "Any Style"-like style-tile strip to Generate for approachability
  (we have styles and LoRAs; presenting a few as visual tiles closes the Image Playground
  approachability gap without new backend).

### P4. Camera intelligence: beat the iOS 27 Home app, locally

Apple's fall Home app camera features are our clearest chance to be visibly ahead of a
headline Apple feature, using plumbing we already have (Frigate + VLM descriptions + nomic
embeddings). Their version needs a 2TB iCloud+ plan; ours is local.

- **NL footage search**: embed the stored Frigate event descriptions
  (`backend/src/lib/frigate/events.ts`) with `nomic-embed-text`; add a search box to the
  Cameras page ("the dog in the backyard yesterday", "person at the front door with a
  package"). FTS5 + vector re-rank, same recipe as podcast transcript search
  (`podcastAi.ts`).
- **Daily camera digest**: an LLM activity summary per camera per day ("3 deliveries, the
  usual school pickup, one unknown vehicle at 22:14"), surfaced as a Cameras page card and
  an optional Daily Briefing section.
- **Noteworthy-clip surfacing**: promote events whose safety pass or description scores
  unusual (unknown person at night, vehicle idling) to the notification bell as
  `time-sensitive` (composes with P2).
- Person/face recognition against household profiles is deliberately deferred: privacy
  posture and consent UX need their own discussion first.

### P5. Live conversation translation

The one capability gap with real family utility we cannot currently answer at all.

- New "Translate" surface (a tool page plus a chat tool): two-party conversation mode.
  Pipeline is entirely existing parts: streaming Whisper STT (`/api/stt/stream`) with
  language auto-detect, LLM translation (same prompt family as
  `lyricsTranslate.ts`/`videos/translate.ts`), Kokoro TTS out.
- Constraint to state up front: Kokoro's voice coverage limits spoken output languages
  (strong for English/Spanish/French/Italian/Portuguese/Hindi/Japanese/Chinese); for
  unsupported target languages fall back to on-screen text like FaceTime captions.
- UI: split-screen two-column layout (one column per speaker/language), tap-to-talk or
  VAD-driven hands-free, transcript running down each column. Phone-first layout.
- Also close a near-parity hole cheaply: point the existing caption-translation pipeline at
  the podcast transcript panel (translated transcripts), matching iOS 27's system-wide
  translated captions.

### P6. Assistant UX parity polish (Siri AI patterns worth stealing)

- **Ask from Spotlight**: when a `SpotlightSearch` query matches nothing (or via a persistent
  "Ask Loki" row), submit it to the companion. Mirrors Siri-in-Spotlight on macOS 27 and
  makes ⌘K the true "type to assistant" entry point.
- **Retention controls**: per-user auto-delete for chat history (month / year / forever) in
  Settings. Trivial sweep job, meaningful privacy story, direct parity with the Siri app.
- **Semantic app index**: extend Spotlight results beyond navigation into content (notes,
  inventory items, podcasts, books) using existing embeddings. This is Apple's iOS 27
  semantic index, and most of our indexes already exist.
- **Desktop screen-awareness**: pass the active route/app context into companion turns on
  desktop the way the mobile quick-ask sheet already does, so "what am I looking at" works
  everywhere.

### P7. AI presentation grammar (adopt the HIG rules as our Visual Language)

Small, cross-cutting, mostly copy and component work; proposes additions to `agents.md`
Visual Language:

- **One AI-content label**: a shared `AiGeneratedBadge` (sparkle glyph + short label, e.g.
  "Summarized by Loki", "Made with Imaging") applied consistently to podcast insights,
  briefing digests, notification summaries (P2), camera digests (P4), and AI-authored
  books/podcasts. Today labeling is inconsistent across these surfaces.
- **Edit / Undo / Retry adjacent to output**: we have Regenerate in chat; add Retry beside
  image results and Undo ("Original" toggle) beside every writing-tools edit (P1) and the
  Canvas edit pass. Codify as a rule: no generated artifact without an adjacent revert.
- **Specific status text over spinners**: already our pattern in chat (`RoutingStatus`) and
  ad-scan; codify it and sweep the few remaining generic spinners on AI paths (image gen
  steps already comply).
- **A "Local AI Report"**: our answer to Apple Intelligence Report, and a brand moment.
  A settings page listing recent AI activity (which model role served what, on which
  engine), with the headline every row supports: nothing left the house. Data mostly
  exists in the admin AI Engine census; this is a user-facing, read-only reframe.
- **Shimmer-resolve for generation**: a single shared shimmer treatment (we have one on
  `DownloadProgress`) for "content is being generated here" states, replacing per-surface
  improvisation.

### Non-goals (deliberate)

- **Genmoji**: conflicts with the no-emoji-as-UI rule and adds little for a family hub.
- **Liquid Glass**: our calm-surface language is a considered position; Apple itself has
  walked transparency back three times. No change.
- **Cloud model fallback (ChatGPT/Gemini handoff)**: local-only is the product.
- **Telephony features** (Call Screening, Hold Assist, voicemail summaries): no telephony.
- **Face recognition on cameras**: deferred pending a consent design, not rejected.

## 4. Suggested sequencing

P3 Clean Up and P6 polish items are the quickest visible wins. P1 Writing Tools is the
largest single gap and should anchor the first real phase. P4 camera intelligence is the
strategic one: it lands before Apple ships their version this fall, and composes with P2.
P5 translation is the only net-new subsystem and can trail.

Fit with the existing roadmap: P4 complements the phase-3 "AI-native routines engine"
(camera events as routine triggers once AI events are trustworthy), and P2/P7 are
prerequisites for tasteful proactive behavior anywhere else.
