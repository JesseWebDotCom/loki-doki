# LokiDoki Bug Tracker

Active issues discovered in production UX that aren't yet fixed. Close
by deleting the row when the fix lands (link the commit in the PR).

| ID | Area | Status | Summary |
| -- | ---- | ------ | ------- |
| BUG-1 | Maps / hover | open | Duplicate hover cards per business — one renders with icon + category, the other is missing both |
| BUG-2 | Maps / POI layer | open | Named businesses missing from the map but appear on building hover |
| BUG-3 | Voice / TTS | open | Fast-lane replies (e.g. "hi" → "Hello.") render in the bubble but are never spoken aloud; longer replies speak fine |

---

## BUG-1 — Duplicate hover cards per business

**Where:** `frontend/src/pages/MapsPage.tsx` — `poi_icon` vs `buildings-3d`/`buildings-2d` hover handlers.

**Symptom:** Moving the cursor across a single business can surface two
different hover cards depending on where the cursor lands:
- Over the POI glyph → full card with subclass icon + category label.
- Over the building footprint → card with the same name/address but no
  icon badge and no category chip (or a coarser one).

**Likely cause:** two independent code paths build the hover target.
The `poi_icon` path reads `subclass`/`class` straight off the vector
tile and maps it via `POI_CATEGORY_ICON`, while the building path goes
through `hydrateBuildingHover` → `reverseGeocode` and depends on the
FTS `category` column being granular (`poi:<key>:<value>`). Legacy
indices that still store the coarse `poi:<key>` form fall back to the
top-level key icon (`amenity → default`), which visually reads as
"no category." When the two paths race during cursor drift, the user
perceives "two cards, one missing category."

**Repro:**
1. Install an older region (FTS built before the subclass change).
2. Hover the POI glyph for a named business — card A appears with icon.
3. Slide the cursor onto the same building's footprint — card B appears
   without the subclass icon / label.

**Fix direction:**
- Unify the two hover paths so the building path reuses the tile
  feature's `subclass` when the cursor lands on a footprint that hosts
  a POI glyph (cheap: `queryRenderedFeatures` at the pointer against
  `poi_icon` before falling back to reverse-geocode).
- Force-rebuild the FTS index on upgrade so every installed region
  emits `poi:<key>:<value>` (today, only freshly built indices do).
- Add a test that simulates the drift sequence (mousemove POI →
  mousemove building on the same business) and asserts both cards
  carry the same icon + category.

---

## BUG-2 — Named businesses missing from the map until hovered

**Where:** map style + tile pipeline — `frontend/src/pages/maps/style-dark.ts`
(`poi_icon` layer) and the planetiler POI profile the bootstrap builds.

**Symptom:** A real business that the geocoder knows about (e.g.
"Planet Fitness" at 177 Cherry Street) renders as a bare housenumber
("177") on the basemap. Hovering the building synthesises a hover card
correctly because the FTS nearest-neighbour finds the POI — but the
user had no visual hint the business was there.

**Likely cause:** the vector tile's `poi` source-layer doesn't include
every named business the FTS index carries. Possible contributors:
- The planetiler profile filters on a stricter key/value list than the
  FTS indexer (`_POI_KEYS` in `lokidoki/maps/geocode/fts_index.py`).
- Certain subclass values (`leisure=fitness_centre`, `office=company`,
  some `shop=*` combos) get dropped by the planetiler POI profile.
- Way-centroid POIs (named buildings with no standalone node) survive
  in the FTS row but are absent from the tile's point POI layer.

**Repro:**
1. Open the map at 177 Cherry Street, Milford CT (or any other named
   business you know lives in the FTS index).
2. Observe only the housenumber renders — no icon/label badge.
3. Move cursor over the building → hover card for the business pops.

**Fix direction:**
- Audit the planetiler POI profile used by the bootstrap tile build;
  widen it to match the FTS `_POI_KEYS` list.
- Emit tile POIs for named building polygons via centroid so
  way-only POIs render.
- Add a tile-build smoke test that renders a fixture region and
  asserts every FTS `poi:*` row has a matching `poi` tile feature
  within ~50 m.
- Until the tile profile is fixed, consider a runtime overlay that
  reads the FTS index and draws a lightweight symbol layer for any
  business missing from the tile POI layer.

---

## BUG-3 — Fast-lane replies render but are never spoken

**Where:** `frontend/src/pages/ChatPage.tsx` (commit path in
`commitCompletedAssistantMessage`) × `frontend/src/utils/tts.ts`
(`speak` → `speakNow` → `VoiceStreamer.stream`). Surfaces only on
turns that take the pre-parse fast-lane (e.g. `greeting_response`),
which bypass the rich-response envelope entirely.

**Symptom:** With read-aloud ON and streaming-voice ON, sending "hi"
displays the assistant bubble ("Hello.") but no TTS audio plays.
Longer replies that go through the normal synthesis pipeline speak
correctly.

**Likely cause:** The fast-lane backend emits only the legacy
`synthesis:done` + terminal `response_done` events — no
`response_init`, no `block_patch`, no `response_snapshot`
(`lokidoki/orchestrator/core/streaming.py:272-287`,
`lokidoki/orchestrator/core/pipeline.py:158-169`). In the frontend,
this means `beginStreamingTurn` is never called, `inProgressIndex`
stays `null`, and `commitCompletedAssistantMessage` lands in its
append-path branch at `ChatPage.tsx:973-980`:

```ts
setMessages((msgs) => {
  ...
  const next = [...msgs, { role: 'assistant', content: payload.finalText, ... }];
  const spoken = resolveSpokenText(payload.envelope)
    || payload.pipeline.synthesis?.spoken_text?.trim()
    || payload.finalText;
  if (readAloudEnabledRef.current) {
    ttsController.endStreamingTurn(`msg-${next.length - 1}`, spoken); // no-op (no turn)
    tts.speak(`msg-${next.length - 1}`, spoken);
  }
  return next;
});
```

Unit tests against the real `TTSController` confirm the underlying
`speak` → `speakNow` → `streamer.stream` path works for fast-lane in
isolation (fresh call, prior long-reply tail, double-invocation).
So the bug is NOT in the controller itself — the real-app breakage
sits at the ChatPage integration seam. Two plausible root causes:

1. `tts.speak` is called from **inside** a `setMessages` updater,
   which also sits inside a `setPipeline` updater at
   `ChatPage.tsx:1092-1103`. Side effects in pure updaters are a
   React anti-pattern and interact badly with StrictMode
   double-invocation and update batching.
2. Fast-lane completes in <1 ms, so `isProcessing` flips back to
   `false` in the same tick that `speakNow` sets `pendingKey`. The
   refocus-after-turn `useEffect` (`ChatPage.tsx:421-434`) then
   triggers the input's `onFocus`, which calls `bargeIn()` when
   `tts.pendingKey` is set. The `suppressFocusBargeRef` guard is
   supposed to prevent this, but the microtask-clear timing vs. the
   synchronous focus-event dispatch is fragile.

**Repro:**
1. Settings → Audio: read-aloud ON, streaming voice ON.
2. Send "hi" (or any greeting that matches `greeting_response`).
3. The bubble shows "Hello." but no audio plays. A long reply in
   the same session speaks fine.

**Diagnostic still needed:** Open DevTools → Network tab and confirm
whether `POST /api/v1/audio/tts/stream` fires for the short reply.
- If it fires → audio pipeline side (possibly `stop()` cutting the
  newly-started stream, or the AudioContext scheduler dropping a
  chunk that's too short).
- If it doesn't fire → the ChatPage flow is short-circuiting before
  `speak` (stale `readAloudEnabledRef`, barge-in racing `pendingKey`,
  or the setMessages-inside-setPipeline updater impurity).

**Fix direction:**
- Move `ttsController.endStreamingTurn` + `tts.speak` out of the
  `setMessages` updater and run them after state commits (either
  after the `setMessages` call site or in a one-shot `useEffect`
  triggered by a "pending TTS" ref). This eliminates the side-effect-
  in-updater anti-pattern regardless of which root cause is real.
- Consider calling `beginStreamingTurn` unconditionally at
  `handleSend`/turn-start (not gated on `response_init`) so fast-lane
  replies flow through the same `finalizeStreamingTurn` →
  `chainStreamingTail` path as long replies, for one coherent code
  path instead of the current speakNow/chainStreamingTail fork.
- Add a test under `frontend/src/pages/__tests__/` that uses the real
  `ttsController` (mock only `VoiceStreamer`) and drives the fast-lane
  event sequence (`synthesis:done` + `response_done` with no
  `response_init`), asserting `streamer.stream` is called with the
  reply text.
