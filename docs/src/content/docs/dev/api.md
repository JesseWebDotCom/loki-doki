---
title: API Reference
description: Backend HTTP API routes organized by subsystem.
sidebar:
  order: 11
---

import { Aside } from '@astrojs/starlight/components';

<Aside>
This page is a work in progress. Routes are documented as subsystems are finalized.
</Aside>

All routes are prefixed with `/api`. Authentication is required for all routes unless noted.

---

## Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Login with username + PIN |
| `POST` | `/api/auth/logout` | Invalidate session |
| `GET` | `/api/auth/me` | Current user info |

---

## Chat

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/conversations` | List conversations |
| `POST` | `/api/conversations` | Create conversation |
| `GET` | `/api/conversations/:id/messages` | Load messages |
| `POST` | `/api/chat/stream` | **SSE**: send message, stream response |

---

## Image Generation

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/imaging/generate` | Start generation job |
| `GET` | `/api/imaging/status/:jobId` | **SSE**: generation progress |
| `GET` | `/api/imaging/gallery` | List generated images |
| `DELETE` | `/api/imaging/:id` | Delete image |

---

## TTS / Voice

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/tts/stream` | **SSE (NDJSON)**: stream PCM audio chunks |
| `GET` | `/api/voice/wakeword/:file` | Serve wakeword ONNX model |

---

## Vision

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/vision/analyze` | Analyze image with VLM |

---

## Maps

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/maps/search` | FTS geocoder |
| `GET` | `/api/maps/route` | GraphHopper routing proxy |
| `GET` | `/api/maps/tiles/:region/*` | pmtiles proxy |

---

## Library

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/library/archives` | List ZIM archives |
| `GET` | `/api/library/proxy/*` | kiwix-serve proxy |

---

## Boot

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/boot/status` | Component install status |
| `GET` | `/api/boot/repair/stream` | **SSE**: auto-repair progress |

---

## Admin

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/chat-benchmark/stream` | **SSE**: chat latency benchmark |
| `GET` | `/api/admin/router-benchmark/stream` | **SSE**: router accuracy benchmark |
