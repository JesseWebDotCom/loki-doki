---
title: Home Control
description: Natural-language smart-home control, our own NLP over a WebSocket-synced Home Assistant catalog, deterministic resolver + LLM fallback, per-user domain×area grants.
sidebar:
  order: 13
---

## Overview

Home control lets the companion run smart-home commands ("turn off the office lights", "are the office lights on") in natural language. We do the NLP ourselves and drive Home Assistant's REST service API directly. HA's built-in conversation agent is bypassed entirely (its template grammar is too rigid, and an LLM agent inside HA hits the ~25-entity limit and needs a second model).

Engine lives in `backend/src/lib/homeAssistant/`. Exposed as the `homeAssistant` chat tool (`backend/src/tools/homeAssistant.ts`). A tap-to-toggle dashboard at `/home-assistant` (`frontend/src/pages/HomeAssistantPage.tsx`) is backed by `backend/src/routes/homeAssistant.ts`.

---

## Architecture

```
message → router (Tier-1 passthrough, passMessage:'text')
  → tool.execute → handleCommand
      → ensureConnected (live WebSocket store)
      → deterministicResolve (instant, no LLM)
          ↳ follow-up correction (per-conversation context)
          ↳ LLM fallback (scoped candidates) only if unresolved
      → permission filter (per-user domain × area grants)
      → execute:  control → REST callService
                  query   → read live state from the store
  → directReply (speaks the result, skips LLM synthesis)
```

### Live sync (`sync.ts`)

A persistent **WebSocket** to HA (`/api/websocket`): authenticate, pull the area + entity + device registries (accurate rooms via `entity.area_id ?? device.area_id`), then `subscribe_entities` for a push-updated state map. One socket per HA instance, auto-reconnect, registry refresh on an interval. The catalog stays hot, so state queries are instant and always fresh with no polling. `getStore(conn)` returns the live store; `ensureConnected(conn)` connects-or-reuses.

### Resolver (`resolve.ts`)

Deterministic-first, no LLM for common cases: detects the action verb, a domain keyword, the longest matching area name, and "all". Brightness is parsed deterministically too: `set/make/change … N%`, `dim` (default 30), `brighten`/`brighter` (default 90). `narrowByName` lets "office ceiling light" target one entity within an area+domain match. `scopeCandidates` narrows the catalog (never 700+ entities) for the LLM fallback.

### Control (`client.ts`)

REST `callService`. Turn-on/off/toggle group through `homeassistant.turn_on/off/toggle` so mixed-domain targets work in one call; brightness is `light.turn_on` with `brightness_pct`; plus `lock.*`, `cover.open_cover`/`close_cover`, `scene.turn_on`. Also exports `describeError` (offline vs other) and `normalizeConnection`.

### Follow-ups (`context.ts`)

Per-conversation in-memory store (key `userId:convId`, TTL) of the last control plan, set on a successful control. Bare corrections ("I meant 20", "turn those off") carry no device keywords, so `routes/chat.ts` overrides routing to `homeAssistant` when `isFollowUp(msg) && hasRecentContext(...)`, and `handleCommand` re-resolves against the remembered targets via `followUpResolve`.

### Permissions (`permissions.ts`)

`ha_user_grants` table: per-user `(domain, areaId)` scopes, `*` wildcard on either axis. Admins bypass; a user with no rows controls nothing. `filterByGrants` filters resolved targets for both control and query. The dashboard's direct `/entity` toggle enforces the same: a non-admin can only toggle an entity present in the synced catalog and allowed by their grants (fail-closed).

---

## Snappiness

- **Tier-1 routing**: `passMessage:'text'` means a confident embedding-similarity match in the router passes the verbatim message straight through as `{ text }` with no Tier-2 LLM call.
- **No synthesis**: every outcome (success, not-found, no-permission) returns via the `directReply` field on `ToolResult`. `routes/chat.ts` emits it as the assistant message directly and skips the LLM synthesis pass. Only transport failures return `offline` (which falls back to a generated "unavailable" message).
- **Deterministic resolution**: common commands never touch an LLM; the fallback fires only on ambiguous phrasing (and only if `llm_fallback` is on).

---

## Dashboard routes (`/api/home-assistant`)

`routes/homeAssistant.ts`:

- `GET /entities`: per-user resolved config; returns controllable entities (`light`, `switch`, `fan`, `lock`, `cover`, `climate`, `input_boolean`, `media_player`) with state + area, for the room grid.
- `POST /entity`: direct single-entity `turn_on`/`turn_off`, bypassing the NL resolver. Grant-checked for non-admins.
- `POST /command`: runs a free-text command through the tool and returns its `directReply`.

---

## Admin API

`/api/admin/home-assistant/{status,sync,catalog,grants}` (`routes/adminHomeAssistant.ts`). `status` reports configured/connected/lastSync/entities/areas; `sync` forces a (re)connect; `catalog` returns areas, domains, and entities for the grant UI; `GET|PUT /grants` read/write per-user `(domain, areaId)` scopes. The UI is `AdminHomeAssistantSection`, rendered inside the tool's Config panel: connection status + Sync now + per-user domain×area grant editor. Boot warms the socket via `startHomeAssistantSync()`.

---

## Configuration

Tool config (Admin → Features → Home Assistant): `base_url`, `api_token` (secret), `llm_fallback` (bool, default on). `base_url`/`api_token` are **global/admin-only on purpose**: HA lives on the LAN so private addresses can't be SSRF-blocked, so only the trusted admin sets where the connection points (prevents a non-admin repointing it at an internal service). The `ha_user_grants` table is created on boot (belt-and-suspenders `CREATE TABLE` in `db/index.ts`).

## Not yet wired

- Thermostat set (`climate.set_temperature`): "set thermostat to 70" detects the `climate` domain but `buildServiceCalls` has no climate case, so it has no effect.
- Relative brightness ("a bit brighter"): the store keeps state strings, not the brightness attribute, so relative adjustment can't read the current level.
- Control uses REST `callService`, not WebSocket `call_service`.
