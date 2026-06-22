---
title: Home Inventory
description: AI-first device tracker, photo → OCR/VLM identify → web lookup → manual cache + RAG, with service logs and warranty alerts.
sidebar:
  order: 12
---

## Overview

Home Inventory is an AI-first device tracker. The primary workflow is photo → identify (OCR + VLM) → background web lookup → structured record with a locally cached, text-extracted manual. It's a full page at `/home-inventory` and is also wired as the `home_inventory` chat tool.

Routes live in `backend/src/routes/home.ts` (mounted at `/api/home`). The web-lookup engine is `backend/src/lib/home/lookup.ts`. The chat tool is `backend/src/tools/homeInventory.ts`.

---

## Data Model

Four tables in `backend/src/db/schema.ts`:

- `home_devices`: the device record. Identity (`name`, `brand`, `model`, `serialNumber`, `category`, `location`, `owner`), provenance (`rawLabelText` = verbatim OCR, `specs` = JSON key-value object, `manufacturedDate`), purchase/warranty (`purchaseDate`, `purchasePrice`, `purchaseStore`, `warrantyExpires`, `warrantyNotes`), support (`supportUrl`, `supportPhone`), manual (`manualUrl`, `manualPath` = cached PDF, `manualText` = extracted text, `manualFetchedAt`), `photoPath` / `mainPhotoId`, and `lookupStatus` (`pending` | `complete` | `failed` | `skipped`) + `lookupQueuedAt`.
- `home_service_log`: per-device service entries: `date`, `type` (`repair` | `maintenance` | `inspection` | `upgrade` | `other`), `description`, `technician`, `cost`.
- `home_device_files`: attachments: `label`, `filePath`, `fileType` (`pdf` | `image` | `other`), `source` (`user` | `ai`), `comment`. AI-found product photos and uploaded PDFs both land here.
- `home_device_links`: `category` (`manual` | `support` | `download` | `video` | `other`), `label`, `url`. AI-found how-to videos are saved here.

Category enum: `appliance | electronics | vehicle | tool | furniture | other`.

---

## Identify Pipeline

`POST /api/home/devices/:id/identify` runs three passes, separating reading from reasoning so the model can't hallucinate label values:

1. **OCR**: on macOS, an Apple Vision Swift script (`VNRecognizeTextRequest`, accurate level, language correction off to preserve model numbers, multi-language) reads the label. The script is written to `data/home/vision_ocr.swift` once. On non-macOS, or if Vision yields too little text, it falls back to a VLM OCR pass that transcribes all visible text.
2. **Visual description**: a VLM pass describes the object's physical form only (no text reading). Runs in parallel with the OCR fallback (`Promise.allSettled`).
3. **Extraction**: a text-only LLM (no image) reconciles the two evidence sources into structured JSON: `name`, `brand`, `model`, `serialNumber`, `category`, `manufacturedDate`, `labelSpecs`, plus a `confidence`. The system prompt forbids substituting product knowledge; the model must copy values verbatim. JSON is extracted with a brace-depth scanner and trailing-comma sanitizer rather than a greedy regex.

Vision/extraction models come from `getVisionModel()` and `getModel()` (Ollama). `rawLabelText` is persisted to the device. The endpoint returns the identified fields for the client to review before saving; the user confirms/edits, then the record is written.

---

## Web Lookup

When a device has a brand and model, `triggerLookup()` fires a fire-and-forget `lookupDevice(brand, model, name, deviceId, category)` (in `lib/home/lookup.ts`) and sets `lookupStatus: 'pending'`. The client polls `GET /api/home/devices` every 3 s while any device is pending. It can also be re-run via `POST /api/home/devices/:id/lookup`.

`lookupDevice` runs in parallel:

- **Search guidance + device info**: an LLM produces targeted DuckDuckGo queries (`name user manual filetype:pdf`, a support-page query) and a baseline spec/description sheet.
- **Manual PDF**: DuckDuckGo HTML search (`ddgSearch`) for the PDF, then `tryFetchManualPdf` downloads it to the device's `files/manual.pdf`, runs `pdftotext` to extract `manualText`, and records `manualUrl` / `manualPath`. All fetched URLs pass `assertPublicUrl` (SSRF guard, the URLs are search-derived).
- **Support page**: scraped for a phone number and product images.
- **Product photos**: up to 3 images downloaded into `home_device_files` (`source: 'ai'`); the first becomes the cover (`photoPath` / `mainPhotoId`).
- **Videos**: how-to links saved into `home_device_links` (`category: 'video'`).

On success the device is patched to `lookupStatus: 'complete'` with merged specs (AI specs over any label-extracted specs). Any thrown error sets `lookupStatus: 'failed'`; the device record survives regardless.

---

## Manual Cache + RAG

The manual PDF is cached on disk; its text lives in `home_devices.manualText`. Two retrieval paths:

- **Per-device chat** (`POST /api/home/devices/:id/ask`, SSE) builds a system prompt from the device context + parsed specs + up to 8 KB of manual text and streams a grounded answer ("answer only from the provided context").
- **Chat tool** uses a keyword-overlap extractor (`extractRelevantManualSection`): it splits the manual into paragraphs, scores each by how many of the question's words (>3 chars) it contains, and returns the top 3 (capped at 4 KB). With no question, it returns the first 4 KB. This is lightweight lexical RAG, not embeddings.

Uploaded PDFs (`POST /api/home/devices/:id/files`) run the same `pdftotext` extraction (`extractPdfTextAsync`) when no `manualText` exists yet. `GET /api/home/devices/:id/manual` serves the cached PDF.

---

## Warranty / Service Logic

Warranty is date math on `warrantyExpires` (no scheduler). `GET /api/home/warranties?days=N` returns `{ expiring, expired }` split on today's date. The page derives the same client-side: a banner for expired or ≤30-day items, a per-card amber/red badge for ≤90/≤30 days. Service entries are plain CRUD against `home_service_log`.

---

## Chat Tool

`home_inventory` (`offline: true`) takes `query` (free-text search over name/brand/model/category/location, returns up to 10 with `warrantyStatus`), `deviceId` (full detail: device fields, parsed specs, links, attached PDF names, full service history, and `manualContext`), and `question` (drives the manual-section extractor). The tool description steers the model to first search, then re-call with the `deviceId` for details.

---

## Routes (`/api/home`)

- `GET /devices` (search `q`, filter `category`), `POST /devices`, `GET|PATCH|DELETE /devices/:id`
- `GET /devices/:id/photo`, `POST /devices/:id/set-main-photo`
- `POST /devices/:id/identify`, `POST /devices/:id/lookup`, `POST /devices/:id/generate-specs`
- `GET /devices/:id/manual`, `GET|POST /devices/:id/files`, `GET|DELETE /devices/:id/files/:fid`, `PATCH /devices/:id/files/:fileId/comment`
- `GET /devices/:id/links`, `POST /devices/:id/ask` (SSE)
- `GET /warranties`, `GET /export`

All require auth.
