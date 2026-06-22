---
title: Privacy & Content Policy
description: The content-policy dial model (floor, ceilings, character gating) and the PIN-gated adult-content state machine.
sidebar:
  order: 15
---

## Overview

Two related but distinct systems live here:

1. **Content policy** (`backend/src/lib/contentPolicy.ts`) governs what the AI is willing to *say*: an always-on safety floor plus four ordered "dials," capped by an admin instance ceiling and a per-user admin ceiling.
2. **Privacy mode** (`backend/src/routes/privacy.ts`, `frontend/src/context/PrivacyContext.tsx`) PIN-gates adult *media* (LoRAs, generated images, music tracks) behind a timed reveal state machine.

The previous consent ledger (`hasFeatureConsent` / `hasToolConsent`, `ConsentModal`) has been **removed**; there are no references left in the codebase. Install-time disclosure in the App Store replaces it.

---

## Content Policy

### Dials

Four independent, ordered, 3-level axes (`DialKey`):

```ts
profanity:  ['off', 'mild',       'full']
sexual:     ['off', 'suggestive', 'explicit']
violence:   ['off', 'moderate',   'graphic']
substances: ['off', 'discuss',    'detailed']
```

`MIN_DIALS` is all `off`; `MAX_DIALS` is the top of each axis. Helpers `normalizeDials`, `levelIndex`, `minLevel`, and `effectiveCeiling` (per-dial stricter-of-two) operate on these. Dials only govern *legal-but-mature expression*; they never relax the safety floor.

### Safety floor

`content.floor` app setting, cached in-process. `getSafetyFloor()` returns the stored prompt or `DEFAULT_SAFETY_FLOOR` (the long refusal policy covering drugs/weapons/hacking/minors/self-harm/etc.). Admin-editable and resettable. `buildContentPrompt(dials)` concatenates the floor with the active per-dial fragments (`DIAL_FRAGMENTS`); neutral/`off` levels for the "open" axes contribute scoping text, and the open levels read as permission to *express*, never as a license to breach the floor.

### Ceilings and the effective level

Three layers, folded with `min()`:

- **Instance ceiling**: `content.ceiling` app setting (`getCeiling`/`setCeiling`, cached). Defaults permissive (`MAX_DIALS`); a self-hosted owner curates by lowering it.
- **Per-user admin ceiling** (parental control): `user_preferences` key `content_ceiling`. Default: admins → `MAX_DIALS`, everyone else → `MIN_DIALS`, so a new non-admin account is fully censored until raised. Only an admin may write this key (the prefs PATCH route blocks `content_ceiling` for non-admins).
- **User self-selected dials**: `user_preferences` key `content_dials`.

`getUserCeiling(userId, role)` returns `effectiveCeiling(adminCap, self)`: the user's own dials hard-capped by their admin ceiling. When the user has never chosen dials it falls back to legacy `safe_mode` + `protections` prefs via `deriveUserCeiling`, or, failing that, to their admin cap. The admin cap is always authoritative.

`GET /api/content/ceiling` (`requireAuth`, `backend/src/routes/content.ts`) returns `effectiveCeiling(instance, userAdminCap)` plus `DIAL_LEVELS`, so the settings UI only offers levels the user is actually allowed to pick.

### Character gating

Characters store their content config as a per-character JSON blob (`{ ...dials, candor }`) parsed by `parseCharacterContent` / written by `serializeCharacterContent`. A character runs at its own authored level ("can't be compromised"); unspecified dials default to `off`.

`characterGate(charDials, ceiling)` returns `{ usable, blockedBy }`: a character is usable only if every one of its dials is within the effective ceiling. Otherwise it surfaces as locked, with `blockedBy` naming the offending dials and required levels.

### Admin content routes (`backend/src/routes/adminContent.ts`, `requireAdmin`)

Mounted at `/api/admin/content`:

- `GET/PUT/DELETE /floor`: read / set / reset the safety floor (DELETE restores `DEFAULT_SAFETY_FLOOR`).
- `GET/PUT /ceiling`: the instance ceiling.
- `GET/PUT /users/:userId/ceiling`: a specific user's admin ceiling (parental cap).

### Frontend

- `frontend/src/components/shared/contentDials.tsx`: the shared `ContentDialGroup` and dial constants.
- `frontend/src/components/settings/SettingsPrivacyTab.tsx`: per-user dials with Safe/Open/Custom presets, clamped to the effective ceiling from `/api/content/ceiling`; persists `content_dials` + `interaction_style.candor`.
- `frontend/src/components/admin/AdminPrivacyTab.tsx`: admin home for both subsystems (safety floor editor + instance ceiling dials, alongside the PIN/keyword/LoRA controls below). Registry section id `privacy`, labeled "Privacy & Content."
- `frontend/src/components/admin/AdminUsersTab.tsx`: per-user admin ceiling via `/api/admin/content/users/:userId/ceiling`.

---

## Privacy Mode (PIN-gated adult content)

### `is_adult` flags

The `is_adult` boolean column (`integer`, default false) is on **three** tables in `backend/src/db/schema.ts`:

- `generated_images`
- `music_tracks`
- `image_loras`

When content is hidden, adult LoRAs are excluded from the picker and adult images/tracks are excluded from galleries until revealed.

### Auto-detection

`backend/src/lib/adultDetection.ts` provides `detectIsAdult(name, description, …, keywords)` and `DEFAULT_ADULT_KEYWORDS`. LoRAs are scanned at import time; admins can edit the keyword list (`privacy.adult_keywords` app setting) and run a full rescan that re-flags every LoRA.

### State machine (`frontend/src/context/PrivacyContext.tsx`)

Four modes, **not** three:

```
hidden     ← default
  → startUnlock / ⌘⇧P         → unlocking
unlocking
  → submitPin (correct)        → revealed (countdown starts at timeoutSeconds)
  → cancelUnlock / ⌘⇧P         → hidden
revealed   (adultVisible = true; secondsLeft ticks down)
  → countdown reaches 0        → hidden
  → keepOpen                   → extended
  → extend                     → adds 30s to the deadline (stays revealed)
  → hide / ⌘⇧P                 → hidden
extended   (adultVisible = true; no countdown)
  → hide / ⌘⇧P                 → hidden
```

`adultVisible` is true in `revealed` or `extended`. The countdown is computed from `revealedAt` + `timeoutSeconds` (default 30) on a 1s interval. The keyboard shortcut is `(metaKey || ctrlKey) && shiftKey && key==='P'`: it opens the unlock prompt from `hidden`, cancels from `unlocking`, and hides from `revealed`/`extended`.

### Backend (`backend/src/routes/privacy.ts`)

Mounted at `/api/privacy`. App settings: `privacy.enabled` (default true), `privacy.timeout_seconds` (default 30, clamped 10–3600), `privacy.pin_hash`.

- `GET /settings` (`requireAuth`): `{ enabled, timeoutSeconds, hasPin }`.
- `POST /verify` (`requireAuth`): verifies the PIN with `verifyPin`/`hashPin` (`backend/src/lib/pin.ts`). Two layers of brute-force defense: a per-IP throttle (`pinThrottle`) and a per-user lockout persisted to `app_settings` as `privacy.lockout.<userId>` so it survives a restart. After 5 failures the account locks for `lockoutDuration(count)`; the window resets cleanly on expiry or on success.
- `GET/POST /admin/settings` (`requireAdmin`): read/update enabled, timeout, and PIN.
- `GET/POST /admin/keywords` (`requireAdmin`): manage the adult-detection keyword list (reset restores defaults).
- `POST /admin/rescan` (`requireAdmin`): re-flag all LoRAs against the current keywords; returns `{ scanned, flagged }`.

### Admin tab

`AdminPrivacyTab` exposes Privacy Mode (enable, reveal timeout, set/change PIN with confirm + min-length), Adult Detection Keywords, and Style Adult Flags (per-LoRA `is_adult` toggle + rescan), plus the content-policy controls described above.
