---
title: Companion System
description: DiceBear avatar engine, CompanionOverlay, per-user grants, and lip-sync.
sidebar:
  order: 4
---

## Overview

The companion system is renderer-agnostic, any DiceBear-compatible avatar style can be used. Companions have a personality prompt, a voice, and a visual appearance. They can be granted to specific users or made global.

---

## Avatar Engine

**Engine:** DiceBear (via `@dicebear/core` + style packages)

The `DiceBearRenderer` component renders SVG avatars from a seed + style configuration. The head group is split out into its own SVG group (`.ld-head-rot`) so it can be rotated independently for the head-tilt behavior:

```css
.ld-head-rot {
  transform-box: fill-box;
  transform-origin: 50% 62%;
  transform: rotate(var(--ld-head-rotate, 0deg));
}
```

This uses `fill-box` (bounding box of the element itself) so the head cocks naturally around its own center rather than the SVG viewport origin. A broad `id` selector would double-rotate nested hair/eyebrow parts, only the specific head group class is targeted.

---

## Companion Overlay

The `CompanionOverlay` is a **global floating overlay**: it persists across all pages and is mounted at the app root, not inside any page component. It provides:

- Avatar with breathing animation (`animate-breathing`) and startle/tilt behaviors
- Floating input field for direct companion interaction
- Speech bubble for companion responses
- Lip-sync driven by text cadence (syllable count → CSS animation timing)

When no companion is selected, the overlay shows an animated `CompanionOrb`, a canvas-based pixel orb that pulses, breathes, and sparkles to indicate the system is alive and ready.

---

## Text-Cadence Lip-Sync

Lip movement is driven by the incoming token stream, not audio analysis. As tokens arrive via SSE, the overlay counts syllables in the streamed text and drives a CSS mouth-shape animation. This gives the illusion of speech in sync with the TTS without needing audio analysis.

---

## Admin Studio

Admin → Companions provides:
- Create / edit / delete companions
- Avatar style picker (DiceBear style + seed + color params)
- Personality prompt editor
- Voice assignment (Kokoro voice picker with preview)
- Per-user grant management

---

## Per-User Grants

Companions use a **default-visible** permission model:
- Active + published companions are visible to all users by default
- Per-user revocations are stored in the `character_user_grants` join table with `state = 'off'`
- Admins see all companions regardless of publish/active state

---

## Wakeword Per Companion

Each companion can have a dedicated wakeword associated with it (in addition to the global wakeword). Saying the companion's wakeword activates that companion's overlay and voice.

---

## DB Tables

Companion data lives in tables named `characters` / `character_user_grants` / `user_characters`, the DB schema retains these names to avoid migrations; the API and UI surface everything as "companion".
