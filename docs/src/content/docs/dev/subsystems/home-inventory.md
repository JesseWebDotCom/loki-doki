---
title: Home Inventory
description: AI-first device tracker with VLM identification, PDF cache, service logs, and warranty alerts.
sidebar:
  order: 7
---

## Overview

Home inventory is an AI-first device and appliance tracker. The primary workflow is photo → VLM identification → web lookup → structured record. It's also accessible as a chat tool.

---

## Core Flow

```
User takes photo
  → POST /api/vision/analyze (VLM identification)
  → Structured JSON: device name, make, model, serial, category
  → Web lookup: specs, manual URL, warranty period
  → Record saved to inventory_items table
```

---

## Manual PDF Cache + RAG

Product manuals can be cached locally as PDFs. The system:
1. Downloads the manual PDF to `data/inventory/manuals/`
2. Indexes the text for RAG (retrieval-augmented generation)
3. Makes the manual searchable via chat: "how do I reset my router?"

---

## Service Log

Each inventory item has a service log for tracking repairs, maintenance, and replacements:
- Date, description, cost, technician
- Attached photos (before/after)
- Next service reminder

---

## Warranty Alerts

Items with known warranty expiry dates generate alerts:
- Shown on the Today page as a card
- Push notification (if enabled) as expiry approaches

---

## Chat Tool

The home inventory is wired as a chat tool. Users can ask:
- "What appliances do I have in the garage?"
- "When was the HVAC last serviced?"
- "Find the manual for my dishwasher"

The tool returns structured results from the `inventory_items` table and service log.

---

## Route

`/home-inventory`, full inventory browser with search, filter by category/room, and detail view per item.
