---
title: Home Control
description: Natural-language smart-home control — our own NLP over a WebSocket-synced Home Assistant catalog, deterministic resolver + LLM fallback, per-user domain×area grants.
sidebar:
  order: 10
---

## Overview

Home control lets the companion run smart-home commands ("turn off the office lights", "are the office lights on") in natural language. We do the NLP ourselves and drive Home Assistant's REST service API directly — **HA's built-in conversation agent is bypassed entirely** (its template grammar is too rigid, and an LLM agent inside HA hits the ~25-entity limit / needs a second model).

Engine lives in `backend/src/lib/homeAssistant/`. Exposed as the `homeAssistant` chat tool.

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

A persistent **WebSocket** to HA (`/api/websocket`): authenticate, pull the area + entity + device registries (→ accurate rooms via `entity.area_id ?? device.area_id`), then `subscribe_entities` for a push-updated state map. One socket per HA instance, auto-reconnect, registry refresh every 10 min. Keeps the catalog hot so state queries are instant and always fresh — no polling.

### Resolver (`resolve.ts`)

Deterministic-first, no LLM for common cases: detects the action verb, a domain keyword, the longest matching area name, and "all". `narrowByName` lets "office ceiling light" target one entity within an area+domain match. `scopeCandidates` narrows the catalog (never 700+ entities) for the LLM fallback.

### Control (`client.ts`)

REST: `callService` (grouped via `homeassistant.turn_on/off/toggle` to handle mixed domains; `light.turn_on` with `brightness_pct`; `lock.*`, `cover.*`, `scene.turn_on`), plus `describeError` and `normalizeConnection`.

### Follow-ups (`context.ts`)

Per-conversation in-memory store (key `userId:convId`, 180 s TTL) of the last control plan, set on successful control. Bare corrections ("I meant 20", "turn those off") carry no device keywords, so `routes/chat.ts` overrides routing to `homeAssistant` when `isFollowUp(msg) && hasRecentContext(...)`, and `handleCommand` re-resolves against the remembered targets via `followUpResolve`.

### Permissions (`permissions.ts`)

`ha_user_grants` table: per-user `(domain, area)` scopes, `*` wildcard. Admins bypass; a user with no grants controls nothing. `filterByGrants` filters resolved targets (control and query alike).

---

## Snappiness

- **Tier-1 routing**: `passMessage:'text'` → confident matches skip the router LLM.
- **No synthesis**: every outcome (success, not-found, no-permission) returns via the `directReply` field on `ToolResult`; `routes/chat.ts` emits it directly and skips the LLM synthesis pass. Only transport failures return `offline`.
- **Deterministic resolution**: common commands never touch an LLM; the fallback fires only on ambiguous phrasing.

---

## Admin API

`/api/admin/home-assistant/{status,sync,catalog,grants}` (`routes/adminHomeAssistant.ts`). UI is `AdminHomeAssistantSection`, rendered inside the tool's Config panel: connection status + Sync now + per-user domain×area grant editor. Boot warms the socket via `startHomeAssistantSync()`.

---

## Configuration

Tool config (Admin → Features → Home Assistant): `base_url`, `api_token` (secret), `llm_fallback` (bool). The `ha_user_grants` table is created on boot (belt-and-suspenders `CREATE TABLE` in `db/index.ts`).

## Not yet wired

- Thermostat set (`climate.set_temperature`) — "set thermostat to 70" currently falls to the LLM fallback.
- Relative brightness ("a bit brighter") — the store keeps state strings, not the brightness attribute.
- WebSocket `call_service` for control (REST is used today).
