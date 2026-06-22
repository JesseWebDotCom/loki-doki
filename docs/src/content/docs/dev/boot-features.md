---
title: Boot & Feature System
description: Group → Category → Item feature hierarchy, boot screen, and auto-repair via SSE.
sidebar:
  order: 12
---

## Overview

The feature system controls which capabilities are enabled and whether their required models/binaries are installed. It drives the boot screen and the Admin → Features tab.

---

## Hierarchy

```
Group (e.g. "AI", "Media")
  └─ Category (e.g. "Language Models", "Image Generation")
       └─ Item (e.g. "Chat LLM", "Juggernaut XL checkpoint")
```

Defined in `frontend/src/lib/features.ts`. Each item has:
- `key`, unique identifier
- `label`, display name
- `description`, what it enables
- `installComponent`, optional: the backend component key to install/check
- `required`, whether the app won't function without it

---

## Boot Screen

On first load (or after a failed boot), the boot screen:
1. Checks all feature items with `installComponent` set
2. Shows a checklist with green/red status per component
3. **Auto-repairs** missing models or binaries via SSE, the repair runs inline, streaming progress to the boot screen

The repair is a **one-time setup**. Once all components are green, the boot screen is dismissed and the app loads normally.

---

## Auto-Repair via SSE

`GET /api/boot/repair/stream`

Streams NDJSON events:
```json
{ "component": "voice-core", "status": "downloading", "progress": 0.42 }
{ "component": "voice-core", "status": "complete" }
```

The boot screen renders these events as progress bars per component. On completion, the client re-checks all components and either advances to the app or shows remaining failures.

---

## Admin, Features Tab

Admin → Features provides:
- Toggle individual features on/off
- Trigger manual re-install of any component
- View install status and disk usage per component

---

## Adding a New Feature Item

1. Add the item to `features.ts` with a unique `key`
2. If it requires an install step, add a corresponding handler in `backend/src/routes/boot.ts`
3. The boot screen and Admin tab pick it up automatically
