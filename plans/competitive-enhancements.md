# Competitive Enhancements - full plans (2026-07-16)

Derived from a review of the top self-hosted apps (Home Assistant, Immich, Jellyfin,
Open WebUI, Umbrel, Homarr, AudioBookshelf, Frigate, Karakeep, Actual Budget) and the
best-designed Mac apps (NotchNook, MediaMate/DynamicLake, Raycast, Superwhisper, Wispr
Flow, Screen Studio, CleanShot X, Fantastical, Things 3, Dia), then grounded against the
actual codebase. Each item below is corrected for what Loki Doki **already ships** so the
work is "extend/refine" where a feature exists and "build" only where there is a real gap.

No em dashes anywhere in this doc (house rule). Effort key: **S** = under a day,
**M** = 1-3 days, **L** = a week or more, **XL** = multi-week subsystem.

---

## Reality-check scorecard

| # | Enhancement | Status today | Real gap | Effort |
|---|---|---|---|---|
| 1 | Three-state live-activity capsule | EXISTS | Transient "event peek" vocabulary + auto-collapse polish | S |
| 2 | Drop file onto the capsule for the AI | EXISTS (shelf) | Drop onto the *pill* despite click-through | M |
| 3 | Hotkey command palette for the companion | MISSING (hotkey only summons) | The palette itself | M |
| 4 | Proactive, wake-word-free companion | EXISTS (narrow, bell-only) | Broader triggers + optional spoken proactivity | M |
| 5 | Spring physics + visible mic status | EXISTS | Audit/consistency pass only | S |
| 6 | Generative, intent-aware notifications | PLUMBING EXISTS | LLM-authored body in Frigate path + HA event source | M |
| 7 | Local-LLM auto-organization of saves | EXISTS (opt-in) | Unified capture inbox + auto-tag-on-ingest default | M |
| 8 | Persistent memory + tappable citations | MEMORY EXISTS; chips EXIST | `messages.sources` persistence + sources card | M |
| 9 | Family channels (multi-user + AI) | MISSING | Whole subsystem (schema, auth, realtime, identity) | XL |
| 10 | Clean up raw speech before acting | OUTPUT EXISTS; input MISSING | STT disfluency cleanup step | S |
| 11 | Auto-generated starter home screen | MISSING seeding | Builder in `homeLayout.ts` GET `if(!layout)` | M |
| 12 | Guided in-app tour (teach the concept) | MISSING (greenfield) | Coachmark/tour mechanism + per-user flag | M |
| 13 | Background-everything / instant-on | STRONG foundation | Un-gate `AppLoading`; per-user warm snapshot | M |
| 14 | Cross-device resume for every media type | BOOKS/PREFS SYNCED | Unified `mediaProgress` table + live handoff | M |
| 15 | Store cards show per-app permissions | DATA EXISTS | Render summary on `StoreAppCard` | S |
| 16 | User theming / accent API | MODE ONLY | Runtime token override + per-user prefs | M |
| 17 | Transient action pill after an event | PARTIAL (peek tier) | A real post-action action pill | S |
| 18 | Graceful degradation on notchless displays | EXISTS (slim pill) | Audit external-display behavior | S |

**Suggested sequencing.** Ship the cheap high-polish wins first (10, 5, 15, 17, 18, 1),
then the scoped features (8, 6, 3, 11, 16, 14, 13, 7, 12, 4, 2), and treat channels (9)
as its own initiative with a dedicated `/plan`. Every frontend item must end green on
`npx vite build` + `bun run check:design-contract`; every backend item on
`bun build --target=bun backend/src/index.ts`.

---

# GROUP A - Doki Dock (desktop capsule)

The capsule is already mature: `useIslandState.ts` (compact/peek/full via `maxTier`),
`IslandShell.tsx` geometry, the `.island-spring` signature transition in `index.css`
(SwiftUI `interactiveSpring` approximation, reduced-motion honored at L950-953), file
drop (`components/hud/pages/IslandPageShelf.tsx` + `lib/drop.ts`), screen capture (`ipc.js screen:capture`),
and a single global hotkey (`desktop/src/main.js onHotkey`). Do not rebuild these.

## 1. Transient "event peek" vocabulary - S

**Inspiration:** MediaMate/DynamicLake ("the expansion IS the notification").

**Reality:** `activityTier` already forces `peek` while speaking/listening and `full` for
the composer (`IslandShell.tsx` L53). What is missing is a *transient, self-dismissing*
peek for a discrete event (timer done, weather change, package at the door, download
complete) that briefly swells then settles, independent of conversation state.

**Goal.** Any backend/companion event can request a 2-4s glanceable peek with an icon +
one line, then auto-collapse, reusing the existing spring.

**Files to touch.**
- `frontend/src/components/hud/useIslandState.ts` - add an `event` pulse source that
  raises to `peek` for `DISMISS_PEEK_MS` then releases (mirror the existing pointer/idle
  tier merge in `maxTier`, add a 4th input `eventTier` with its own expiry timer).
- `frontend/src/components/hud/IslandExpanded.tsx` - a compact event row variant (icon +
  text), lower priority than live caption, higher than now-playing.
- `frontend/src/components/shell/CompanionEngineContext.tsx` - expose `pulseEvent({icon,
  text, ttlMs})` (this hook does not exist yet; add it).
- Source of events (NOTE, corrected): there is no client notification stream today.
  `useNotifications.ts` only polls `/api/notifications/unread-count` every 30s (too coarse
  to nudge a peek within seconds), and the `surface:'hud'` session SSE carries Drop
  payloads (`useDropReceiver.ts`), not notifications. So this needs one of: (a) a new
  lightweight notification SSE/broadcast the HUD subscribes to, or (b) driving `pulseEvent`
  from the in-process companion/event bus for events the dock already sees (timer done,
  screen-capture complete, now-playing change). Start with (b) for events the HUD already
  has locally; add (a) only when backend-originated events (package at the door) must reach
  the pill live.

**Plan.** (1) Add `eventTier` + timer to `useIslandState`. (2) Add the event row. (3) Wire
`pulseEvent` and call it when a fresh notification arrives while the dock is idle. (4)
Respect reduced-motion automatically (the spring already no-ops).

**Tests.** Mine: `npx vite build`, `check:design-contract`. Yours: trigger a timer/notification
and confirm the pill swells for ~3s and settles without stealing focus or mic.

**Risks.** Do not let event peeks fight a live conversation (gate `eventTier` below
`activityTier` when speaking/listening). Keep copy short: the compact core is ~200px.

## 2. Drop a file onto the pill itself - M

**Inspiration:** NotchNook drag-onto-notch shelf.

**Reality:** Dropping onto the capsule works only when the shelf panel is already open,
because of a documented Electron limitation (`components/hud/pages/IslandPageShelf.tsx` L11-16):
`setIgnoreMouseEvents(forward:true)` forwards mousemove but not OS drag events, so a
click-through window cannot detect a drag hovering it.

**Goal.** Start an OS file drag near the top-center and have the capsule light up and
accept the drop directly onto the pill, no pre-open.

**Files to touch.**
- `desktop/src/main.js` / `desktop/src/ipc.js` - the workaround is shell-side: register a
  short-lived global drag watch. On `will-navigate`/drag we cannot see, so instead add a
  screen-edge hot zone: when a drag is detected via a transparent full-width 1px-tall
  always-on-top helper strip at `y=0` (a tiny secondary BrowserWindow that is NOT
  click-through), reveal the shelf and hand off. Alternatively, expose
  `hud:enable-drag-catch` that momentarily flips `setIgnoreMouseEvents(false)` on
  `dragenter` heuristics.
- `desktop/src/preload.js` - new `onDragProbe`/`setDragCatch` channels.
- `frontend/src/components/hud/IslandShell.tsx` - on drag-catch active, force the shelf
  tier and `useForceIntercept(true)` (the shelf already does this once open).

**Plan.** (1) Prototype the 1px catcher window approach (least invasive, no full-window
intercept). (2) On catcher `dragover`, IPC the HUD to open the shelf + intercept. (3)
Reuse `lib/drop.ts sendFile` for the actual handoff to the companion turn. (4) Document
the residual limitation if the OS still will not cooperate on some setups.

**Tests.** Mine: desktop `bun install` sanity, `npx vite build`. Yours (required, cannot
automate): drag an image from Finder onto the docked pill and confirm it opens the shelf
and attaches to the companion.

**Risks.** This is the riskiest desktop item because it fights an Electron constraint; the
catcher window must never steal clicks (1px, transparent, click-through except during a
live drag). If it proves flaky, downscope to "hotkey opens shelf, then drop" and ship #1
instead.

## 3. Hotkey command palette for the companion - M

**Inspiration:** Raycast (summon, type, act, dismiss; talk OR type).

**Reality:** The global hotkey only summons the HUD or toggles pill/composer
(`main.js onHotkey`). There is a `SpotlightSearch` component in the web app but it is a
navigation search, not an action palette, and it is not in the dock. The action data
already exists: `backend/src/tools/index.ts toolRegistry` (~57 tools with
`name/description/examples`) and `frontend/src/lib/companionAbilities.ts ABILITY_HOSTS`.

**Goal.** Hotkey opens a fuzzy-searchable action list in the capsule full tier: "ask AI",
"set a timer", "what's on my screen", run any enabled tool/app, jump to any app. Fully
keyboard-driveable; typing routes to the companion turn, Enter on an action runs it.

**Files to touch.**
- New `frontend/src/components/hud/IslandCommandPalette.tsx` rendered inside
  `IslandFullExpanded.tsx` as a new paged module (the top bar already has `ISLAND_TABS`).
- Data: a new `GET /api/companions/actions` in `backend/src/routes/companions.ts` that
  returns enabled tools (`getAllowedToolIds` + registry `name/description/examples`) and
  app routes (`APP_GROUPS`), or assemble client-side from `/api/tools` + `appCategories`.
- `frontend/src/components/hud/useIslandState.ts` - a `palette` open state (holdOpen while
  open, like the menu).
- Reuse the existing fuzzy matcher used by `SpotlightSearch`; do not add a dependency.
- Typed submissions flow through the existing `useCompanionStream.submit`.

**Plan.** (1) Assemble the action list (tools + apps + a few built-in verbs: timer,
weather, screen). (2) Palette UI: input + arrow-key list + Enter, Escape closes (wire to
`collapse`). (3) Route: an action with a tool id calls that tool via the companion turn;
an app action opens it via `window.lokiDesktop.openMainWindow(path)`; free text goes to
the companion. (4) Later: per-action aliases stored in `userPreferences`.

**Tests.** Mine: `npx vite build`, `check:design-contract`. Yours: hotkey, type "timer 5
min", Enter, confirm it runs; type a question, Enter, confirm the companion answers.

**Risks.** Keep the palette from duplicating `SpotlightSearch`; if anything, extract a
shared matcher into `shared/`. Respect the design contract (lucide icons only, no emoji as
UI, `bg-brand` accent only).

## 5. Spring/motion + visible mic status - audit only, S

**Reality:** `.island-spring` + `.island-swap` already implement spring morph with
reduced-motion handling; the listening indicator exists in three places
(`CompanionEngineContext listeningState`, `CompanionDock Indicator` Ear icon,
`IslandExpanded`/`IslandFullExpanded`). This item is a consistency pass, not a build.

**Goal.** Guarantee every capsule state change uses the shared spring (no ad-hoc
`transition`), and that mic state is unmistakable in all three tiers including compact.

**Files to touch.** `frontend/src/index.css` (confirm no competing transitions),
`IslandCompact.tsx` (add a small persistent listening glyph to the notch core when
`listening`, today it lives mainly in peek/full), `CompanionOrb.tsx` (confirm the pulse
maps to `listeningState`).

**Plan.** Grep for `transition-` inside `components/hud/`; fold strays into `.island-spring`.
Add a 1-dot listening pulse to `IslandCompact` core. Verify `prefers-reduced-motion`.

**Tests.** Mine: `npx vite build`, `check:design-contract`. Yours: with hands-free armed,
confirm the compact pill visibly shows "listening" without expanding.

**Risks.** None material. Do not add new keyframes; reuse.

## 17. Transient action pill after an event - S

**Inspiration:** CleanShot X post-capture pill.

**Reality:** The peek tier is already transient. What is missing is a peek that carries
1-3 *actions* (e.g. after a screen capture: "Copy / Ask follow-up / Dismiss"; after an
answer: "Open in app / Save").

**Goal.** An event peek variant with up to three inline action buttons that self-dismisses
on timeout or action.

**Files to touch.** Extends #1: add an optional `actions: {label, onRun}[]` to the event
peek payload in `CompanionEngineContext.pulseEvent`; render them in the `IslandExpanded`
event row. Screen-capture completion (`CompanionEngineContext` L400-420) is the first
caller.

**Tests.** Mine: `npx vite build`. Yours: run a screen capture, confirm the pill offers
"Ask follow-up" and dismisses itself.

**Risks.** Tap targets stay >= 40px even in the narrow peek; if three actions do not fit,
overflow into full tier.

## 18. Notchless / external-display behavior - audit, S

**Reality:** `IslandCompact` already renders a "non-notched slim pill" branch, and
`windows.js` docks top-center of the display under the cursor. NotchNook's known flaw
(fake notch on external monitors) is already avoided in spirit.

**Goal.** Confirm and, if needed, refine: on a notchless/external display the capsule is a
clean floating pill (never a drawn fake notch), positioned with a small top margin rather
than flush.

**Files to touch.** `desktop/src/windows.js positionHud` (branch the `y` offset on whether
the active display has a notch via `screen` insets / `hud:get-insets`),
`IslandCompact.tsx` (confirm the slim-pill branch triggers off the same inset signal).

**Tests.** Mine: none automatable. Yours: drag the app to an external monitor, confirm a
floating pill with a small top gap and no fake notch.

**Risks.** macOS multi-display notch detection is fiddly; key off measured inset height,
not display id.

---

# GROUP B - Companion & AI

## 4. Proactive, wake-word-free companion - M

**Inspiration:** Home Assistant Voice chapter 10 (assistant initiates; sustains multi-turn
without re-triggering).

**Reality:** `backend/src/lib/companionProactive.ts` already initiates once/user/day,
daytime only, triggered solely by fresh open-thread memories, delivered to the bell
(never voice). Continued conversation without re-waking already exists in `useHandsFree.ts`
(`POST_REPLY_TIMEOUT_MS`, `MAX_CONTINUATIONS`). So the loop and one trigger exist.

**Goal.** (a) Broaden proactive triggers beyond memory threads (a scheduled routine, a
Home Assistant state, a calendar/timer, "playlist usually starts now"). (b) Optionally let
a proactive message *speak* through the dock when the user is present, not just ring the
bell, gated hard behind a per-user opt-in and presence.

**Files to touch.**
- `backend/src/lib/companionProactive.ts` - generalize `maybeCheckIn` into a trigger
  registry: each trigger returns an optional `{reason, context}`; keep the 1/day + quiet
  hours guardrails as a rate limiter across all triggers.
- New triggers pull from: memories (existing), `userPreferences` routines, Home Assistant
  store (see #6 for the HA event source), timers.
- Spoken delivery: reuse `dockYield.ts shouldSpeakProactively()` (already makes the HUD the
  sole announcer) + a new `proactive.voice` per-user pref; when present and opted in, push a
  `companion:speak` directive to the dock instead of only `emitNotification`.
- `frontend/src/components/settings/notifications/` - add the opt-in toggle.

**Plan.** (1) Refactor to a trigger registry behind the existing rate limiter. (2) Add a
presence check (dock `useBrowserSession surface:'hud'` registration = present). (3) Add the
opt-in + voice path via `shouldSpeakProactively`. (4) Start with two triggers (memory +
one routine) to prove it, then expand.

**Tests.** Mine: `bun build --target=bun backend/src/index.ts`; a unit test for the trigger
rate limiter (pure function). Yours: opt in, simulate a trigger, confirm the dock speaks
once and stays quiet the rest of the day.

**Risks.** Proactive voice is the single most annoying failure mode if wrong: default OFF,
presence-gated, rate-limited, quiet-hours-aware, and never during an active conversation on
another device (the ownership/`dockYield` system already arbitrates this).

## 10. Clean up raw speech before acting - S

**Inspiration:** Wispr Flow (strip filler, fix disfluency).

**Reality:** Output cleanup (reply -> TTS) exists (`speechText.ts stripForSpeech`); input
cleanup does NOT. The Whisper final transcript is only `.trim()`-ed in
`stt-capture.ts` then sent straight to the LLM in `useHandsFree.ts onFinal`.

**Goal.** Normalize the raw transcript (drop "um/uh", collapse false starts, fix obvious
capitalization/spacing) before it is displayed as the user's message and before it goes to
the LLM, without changing meaning.

**Files to touch.**
- New `frontend/src/lib/voice/cleanTranscript.ts` - a pure function: rule-based filler and
  false-start removal (no model). Keep it conservative.
- `frontend/src/hooks/useHandsFree.ts` - apply in `onFinal` before `submitRef.current(text)`
  and before showing the partial-as-final. Keep the raw text for `isStopCommand`.
- Optionally mirror server-side in `backend/src/routes/stt.ts` for the Pod path.

**Plan.** (1) Write `cleanTranscript` + a unit test table (inputs -> expected). (2) Apply in
`onFinal`. (3) Confirm stop-word detection still uses raw text.

**Tests.** Mine: unit test for `cleanTranscript` (pure, fully automatable). Yours: say a
sentence with "um" in it, confirm the shown/submitted text is clean.

**Risks.** Never over-clean (do not drop legitimate words like "um" inside a quote). Rules
only, conservative; no LLM round trip (latency).

## 8. Persistent memory + tappable citations - M

**Inspiration:** Open WebUI (memory + visible citations).

**Reality:** Memory is fully built (`backend/src/memory/`). Citations are *rendered*
tappable already (`CitationChip.tsx`, `transformCitations.ts`, `MarkdownRenderer.tsx`
intercepting `CITE:N`, `companionTurn.ts` emitting a `sources` SSE event). The gap: the
`messages` table has no `sources` column, so on reload the chips vanish; and there is no
"sources list card" under an answer.

**Goal.** Citations survive reload, and each answer can show a compact "Sources" list card
beneath it.

**Files to touch.**
- `backend/src/db/schema.ts` - add `messages.sources` (JSON text, nullable). New migration
  `00NN_message_sources.sql`.
- `backend/src/routes/chat.ts` - persist `sources` on assistant-message insert (the array is
  already produced upstream via `extractSources` in `blockBuilder.ts`); return it on all
  message reads (~302/523/639).
- `backend/src/lib/companionTurn.ts` - thread the same `Source[]` it already emits into the
  persisted row.
- `frontend/src/context/ChatContext.tsx` - on history load, hydrate `message.sources` (the
  live-stream `onSources` handlers at L393/609/725/831 already handle the streaming case).
- New `frontend/src/components/chat/SourcesCard.tsx` - a compact list under the message
  (title + domain + open), shown when `message.sources?.length`. Consumed in
  `ChatMessage.tsx`.

**Plan.** (1) Migration + schema. (2) Persist on insert, return on read. (3) Hydrate on
load. (4) Sources card component. (5) Verify the O(n^2) memo contract (`ChatMessage` is
`React.memo`; `SourcesCard` derived values `useMemo`'d) per the streaming render rule.

**Tests.** Mine: `bun build --target=bun backend/src/index.ts`; `npx vite build`. Yours: ask
a question that cites web sources, reload the conversation, confirm chips + sources card
persist.

**Risks.** Respect the streaming render contract (memoization) or long chats regress to
O(n^2). Keep `sources` payload small (title/url/domain only).

## 7. Local-LLM auto-organization of saves - M

**Inspiration:** Karakeep (local Ollama auto-tag on everything saved).

**Reality:** `backend/src/lib/bookmarks/ai.ts autoTagArticle` (local `structuredCall`),
`summarizeArticle`, embeddings (`bookmarkChunks`), collections/tags, and the AirDrop-style
`Drop` all exist. Auto-tag is opt-in (per RSS/action), not the default ingest pipeline, and
there is no single "capture inbox" across surfaces.

**Goal.** Every new save (bookmark, clip, dropped file, note) runs through `autoTagArticle`
+ a category suggestion on ingest by default, landing in one "Inbox" the companion can
answer questions about, all local.

**Files to touch.**
- `backend/src/routes/bookmarks.ts` - on create, enqueue an auto-organize step
  (`autoTagArticle` mode `existing`/`predefined` against the user's tag set) unless the user
  disabled it; write suggested tags + a category.
- `backend/src/routes/drop.ts`, `routes/clipper.ts`, `routes/notes.ts` - route their saves
  into the same organize step (or a shared `lib/capture/organize.ts` helper wrapping
  `autoTagArticle`).
- `frontend/src/pages/bookmarks/` - an "Inbox" view (recently captured, auto-tags shown,
  one-tap accept/adjust). Reuse `DismissableCard`/`ChipRow` patterns.
- A per-user pref `capture.autoOrganize` (default on) in `userPreferences`.

**Plan.** (1) Extract `lib/capture/organize.ts` from the bookmark auto-tag call. (2) Call it
on ingest across the save routes (async, never block the save response). (3) Inbox UI. (4)
Pref toggle.

**Tests.** Mine: `bun build --target=bun backend/src/index.ts`; `npx vite build`. Yours: save
a link, confirm it lands in the Inbox with sensible local tags within a few seconds.

**Risks.** Auto-tag must be async/background so saving stays instant (Immich principle).
Cap model calls (debounce, one per save). Keep it fully local (no cloud).

## 9. Family channels (multi-user + AI spaces) - XL, own initiative

**Inspiration:** Open WebUI Channels.

**Reality:** Conversations are hard single-user: `conversations.userId` (notNull), every
read/write in `chat.ts` gates on `userId === user.id`, `messages.role` has no "other human"
concept, streaming is per-request SSE to one client. This is a genuine new subsystem, not an
extension. Recommend a dedicated `/plan` before building.

**Goal.** Named shared spaces ("Vacation planning") where multiple family members and the
companion collaborate in one timeline, each human message attributed, the AI @-mentionable.

**Files to touch (all new or substantially reworked).**
- Schema: `channels` (id, name, createdBy, characterId?) + `channelMembers` (channelId,
  userId, role) + generalize messages with `senderUserId` (nullable for assistant/system),
  or a parallel `channelMessages` table to avoid destabilizing 1:1 chat.
- Auth: replace `userId === user.id` guards with membership checks (new middleware).
- Realtime fan-out: reuse the `backend/src/lib/drop/presence.ts` SSE presence/broadcast model
  to push new messages to all connected members (the current chat SSE is single-client).
- Memory scoping decision: `memories`/`entities` are `(userId, characterId)`; a channel needs
  an explicit policy (per-speaker memory read, channel-scoped writes, or none) documented up
  front.
- UI: new channel list + a `MessageList` variant with per-sender identity (avatar/name), an
  @-mention affordance for the companion, membership management.

**Plan (phased, gated).** Phase 0 `/plan` + schema design. Phase 1 read-only shared timeline
(members see one another's messages, no AI). Phase 2 AI participation (@-mention triggers a
companion turn posted to the channel). Phase 3 realtime fan-out. Phase 4 memory policy.

**Tests.** Mine per phase: schema migration applies; `bun build`; membership auth unit tests.
Yours: two profiles in one channel see each other's messages and the AI reply live.

**Risks.** Highest-risk item: touches auth, the streaming contract, and memory scoping at
once. Do NOT fold into 1:1 chat's tables casually; a parallel `channelMessages` table de-risks
the core chat path. Content-ceiling/per-user permissions must still apply per member.

---

# GROUP C - Home, Store, Onboarding, Theming

## 11. Auto-generated starter home screen - M

**Inspiration:** Home Assistant Areas Dashboard (infer a useful dashboard from what exists).

**Reality:** No per-user seeding. A fresh user gets the static system default
(`home.layout.default` or hard-coded `DEFAULT_LAYOUT`) via `homeLayout.ts GET /` when
`getUserLayout()` is null. The widget->tool gating already exists
(`homeWidgets.ts toolId`, `HomePage.isWidgetAvailable`).

**Goal.** On first load, build a starter `HomeLayout` from what is actually installed/present
(enabled tools, Home Assistant devices, media libraries) so a family sees something useful
before touching edit mode.

**Files to touch.**
- `backend/src/routes/homeLayout.ts` - in the `if (!layout)` branch (currently only migrates
  `home.highlights`), call a new `buildStarterLayout(userId)`.
- New `backend/src/lib/home/starterLayout.ts` - query enabled tools (`toolGlobalConfig
  __enabled`, same source as `/api/tools`) and optionally the HA entity store; emit
  `HomeLayout.canvas` rows from `HOME_WIDGETS` whose `toolId` is enabled (weather + a couple
  of high-value widgets by default; music/subs/HA summary only if those tools are on).
- Return it inline WITHOUT persisting (so it stays "auto" until the user edits, then `PUT /`
  saves their version), matching how `DEFAULT_LAYOUT` is a fallback today.

**Plan.** (1) `buildStarterLayout` mapping enabled tools -> widget ids (reuse the existing
`toolId` map). (2) Wire into GET. (3) A small "This is a starter layout, tap Edit to make it
yours" hint in `HomePage` empty/auto state.

**Tests.** Mine: `bun build --target=bun backend/src/index.ts`; a unit test for
`buildStarterLayout` given a tool set. Yours: fresh profile shows a layout reflecting only
installed apps.

**Risks.** Keep it deterministic and small; do not overfill. Never persist until the user
edits (otherwise "auto" becomes stale when they install new apps).

## 12. Guided in-app tour that teaches the concept - M

**Inspiration:** Actual Budget (teach the concept, not just the buttons).

**Reality:** Full-screen `SetupWizard`/`WelcomeWizard`/`LocationOnboarding` exist, but there
is NO coachmark/spotlight/step-highlight tour. Completion flags for setup/welcome are global
`appSettings`; a per-user tour flag should live in `userPreferences`.

**Goal.** A short, skippable, per-user guided tour on first real use that frames "this is
your family's private AI hub, it runs at home, nothing leaves," then points at 3-4 anchors
(companion, App Store, home edit, a kid/content note for admins).

**Files to touch.**
- New `frontend/src/components/onboarding/GuidedTour.tsx` - a lightweight spotlight/coachmark
  (position a card near a target ref; no new dependency, use a portal + measured rects). Steps
  are data.
- Mount in `frontend/src/App.tsx` after auth, gated on a new `userPreferences` key
  `onboarding.tour.completed` (read via `useUserPreferences`, written via PATCH +
  `patchUserPreferencesCache`).
- Anchor refs in `AppShell`/`MobileDock`/companion dock.

**Plan.** (1) Tour primitive (target ref -> positioned card, next/skip, backdrop). (2) Step
data + copy (concept-first, then anchors). (3) Per-user completion flag. (4) A "replay tour"
entry in settings.

**Tests.** Mine: `npx vite build`, `check:design-contract`. Yours: fresh profile sees the
tour once; completing/skipping never shows it again; replay works.

**Risks.** Must be skippable and never trap focus (Mobile Design Contract: back always
exists). Coachmark positioning has to handle phone (393px) and desktop. lucide icons only.

## 15. Store cards show per-app permissions - S

**Inspiration:** Umbrel (visible per-app permissions).

**Reality:** Every `StoreApp` already carries `dataSources: DataSource[]`; the card
(`StoreAppCard.tsx`) shows only a binary online/offline `ConnectivityBadge`. The full
disclosure is in `InstallDisclosureModal`/`ServiceConsentCard`/detail page.

**Goal.** Surface a compact permissions summary on the card itself so parents see at a glance
what an app reaches (e.g. "3 external sources" or "Fully local", with the type mix).

**Files to touch.**
- `frontend/src/components/store/StoreAppCard.tsx` - render a small summary from
  `app.dataSources` (count + a "Fully local" state when empty). Reuse the type chips from
  the modal, but NOTE `SOURCE_META` is currently a non-exported local const in
  `InstallDisclosureModal.tsx` (L39); export it (or lift it to a shared module) first, then
  import it here. No backend change.

**Plan.** (1) Compact summary component (counts by `type`). (2) "Fully local" pill when no
data sources. (3) Keep it one line; full detail stays in the modal/detail page.

**Tests.** Mine: `npx vite build`, `check:design-contract`. Yours: browse the store, confirm
each card shows its source summary and "Fully local" apps read as private.

**Risks.** Do not clutter the card; a count + type dots, not a full list. Badge variants only
(`Badge` `secondary`/`info`), no custom chips.

## 16. User theming / accent API - M

**Inspiration:** Jellyfin (user-injectable themes).

**Reality:** Only light/dark/auto mode is user-customizable (`ThemeContext`,
`appearance.theme` pref). No color/accent customization. The whole UI reads OKLCH tokens
(`--brand`, `--accent`, gradient stops), so overriding those vars at runtime re-themes
everything. The design-contract linter governs *source*, not runtime, so token overrides are
exempt (raw-CSS injection would need sanitization).

**Goal.** Let a household pick an accent (and optionally a small set of curated theme presets)
that overrides `--brand*` (and friends) per user at runtime.

**Files to touch.**
- `frontend/src/context/ThemeContext.tsx` - load `appearance.accent` (and optional
  `appearance.tokens`) alongside `appearance.theme`; apply via
  `document.documentElement.style.setProperty('--brand', ...)` etc. (mirrors how it sets
  `data-theme`).
- New per-user prefs `appearance.accent` / `appearance.preset` in `userPreferences`.
- A curated preset list in a new `frontend/src/lib/themePresets.ts` (each preset = a small map
  of token overrides in OKLCH, staying on-scale).
- Settings UI: a preset/accent picker (reuse `ColorPicker` patterns) in the appearance
  settings tab.

**Plan.** (1) Runtime token-override in ThemeContext. (2) Curated presets (safe OKLCH values,
light + dark variants). (3) Accent picker UI. (4) Optional (later, gated): admin-only raw-CSS
theme with sanitization.

**Tests.** Mine: `npx vite build`, `check:design-contract` (source stays token-based). Yours:
pick an accent, confirm buttons/focus rings/active states retint app-wide and persist across
devices.

**Risks.** Keep presets on the OKLCH scale so contrast stays accessible in both themes. Raw
CSS injection is a separate, later, sanitized, admin-only feature; do not ship it in v1. The
brand *gradient* stays a hero-only element (design contract) even when accent changes.

---

# GROUP D - Platform (sync, performance)

## 13. Background-everything / instant-on - M

**Inspiration:** Immich (background sync; never block the UI) + Wispr Flow (no cold start).

**Reality:** Strong foundation already: warm prefetch (`useAppWarmer.ts`), persisted query
cache (`prefetch/persist.ts`, public content only), durable `downloadJobs` queue, HUD
`backgroundThrottling:false`. The gap: `App.tsx` returns `AppLoading` while auth + boot-status
resolve (the whole tree is gated), and private-app data is never persisted so those screens
spin on cold start.

**Goal.** Render a cached shell instantly and resolve auth/boot in the background; remove
spinners on the most-used private screens via a per-user warm snapshot.

**Files to touch.**
- `frontend/src/App.tsx` - instead of a full `AppLoading` gate on `useAuth().loading`, render
  the shell chrome immediately with skeletons and resolve auth in the background; keep the gate
  only for the genuinely unauthenticated case. Preserve the `BootScreen` first-run path.
- `frontend/src/lib/prefetch/persist.ts` - add a bounded, per-user, logout-wiped snapshot for a
  short allowlist of private roots (e.g. home layout, companion, recent chats) so they paint
  from cache. Must clear on logout (the existing `clearPersistedCache` already does this for
  public roots; extend carefully, private data must never survive logout).
- `frontend/src/hooks/useUserPreferences.ts` already caches to `localStorage` (`ld-prefs:<id>`)
  and is a good model.

**Plan.** (1) Convert the boot gate to a skeleton shell (measure: does anything actually need to
block?). (2) Add per-user persisted snapshot for a tiny allowlist. (3) Verify logout wipe. (4)
Confirm the desktop HUD path is unaffected (it already warms).

**Tests.** Mine: `npx vite build`; a test that `clearPersistedCache` removes the private snapshot.
Yours: cold-load the app and confirm the shell + home paint before the network settles, and that
logging out clears private cache.

**Risks.** Privacy: private data in IndexedDB must be per-user and wiped on logout, no
exceptions (this is a family-privacy product). Do not persist content-ceiling-sensitive data
where another profile could read it.

## 14. Cross-device resume for every media type - M

**Inspiration:** AudioBookshelf (resume at the exact spot on any device).

**Reality:** Books/audiobooks already sync exactly (`bookProgress`, `PUT
/api/books/:id/progress`, KOSync), and prefs sync (`userPreferences`). The gap: video/music/
podcast playback position is not in a unified per-user sync table, and there is no live handoff
push between two open devices.

**Goal.** One `mediaProgress` table (userId + asset ref + positionSec + updatedAt) written on a
heartbeat and read on open, so a show/song/podcast resumes anywhere; optional live handoff nudge
when two devices are active.

**Files to touch.**
- `backend/src/db/schema.ts` - new `mediaProgress` table (analogous to `bookProgress`), unique on
  (userId, assetType, assetId). New migration.
- New `backend/src/routes/mediaProgress.ts` - `GET`/`PUT` (upsert), mirroring `books` progress.
- Frontend players - music (`useNowPlaying`/players), video watch page, podcast player: write
  position on a throttled heartbeat, seek to saved position on open. Reuse the `useViewPreference`
  server-sync pattern.
- Live handoff (optional, phase 2): reuse the `drop/presence.ts` SSE model to nudge other open
  devices.

**Plan.** (1) Table + routes. (2) Wire the three players (write heartbeat, read on open). (3)
Phase 2: live handoff push.

**Tests.** Mine: `bun build --target=bun backend/src/index.ts`; `npx vite build`. Yours: start a
video on one device, open it on another, confirm it resumes at the right spot.

**Risks.** Throttle writes (one per ~10-15s + on pause/close), not per frame. Respect per-user
content ceilings on what is synced/surfaced.

---

## Cross-cutting rules for every item above

- End frontend work green on `npx vite build` AND `bun run check:design-contract`; backend on
  `bun build --target=bun backend/src/index.ts`.
- No em dashes anywhere (copy, comments, commits). lucide icons only, no emoji as UI.
  `bg-brand`/`text-brand` accent only; brand gradient is hero-only. `ConfirmDialog` for
  destructive actions, `sonner` toasts for save/error, `EmptyAppState` for empty states.
- Reuse shared components (`shared/` catalog in `agents.md`); add to `shared/` only when
  composing primitives, and document it there.
- Streaming render contract: any component in the streamed `messages` list stays `React.memo`
  with `useMemo`'d derived values (applies to #8).
- Mobile Design Contract: shell owns safe areas, back always exists, one content column at 393px
  (applies to #11, #12, #15, #16).
- Land on `main` locally; never push to the remote without fresh explicit permission.

## Recommended `/plan` gates before building

- #9 Family channels (new subsystem, auth + schema + realtime + memory scoping).
- #16 raw-CSS theme tier (if pursued beyond curated presets: sanitization design).
- #13 boot-gate removal (touches the auth/boot flow; verify no security regression in the gate).
