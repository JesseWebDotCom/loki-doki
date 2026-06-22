---
title: Vision Analysis
description: Ollama VLM image recognition, structured multi-pass JSON output, and the analysis_results store.
sidebar:
  order: 5
---

Vision analysis turns an uploaded image into structured JSON: a description, scene, detected objects, text/logos, vehicles, safety flags, and inferred context (time of day, country, source camera, weather). It runs entirely locally through an Ollama vision model (VLM). Routes live in `backend/src/routes/vision.ts`, mounted at `/api/vision`.

This is distinct from the in-chat "send the companion a photo" path: that attaches images directly to the companion's chat model and is not part of this subsystem.

## Model

The VLM is resolved by `getVisionModel()` (`backend/src/lib/models.ts`); the default catalog vision model is `gemma3:4b`. `GET /api/vision/status` reports `{ available, model }` by checking the model against `ollamaList()` (matching the exact name or the base tag prefix).

## Multi-pass inference

Rather than one prompt, `POST /api/vision/analyze` runs several focused passes in parallel via `Promise.all`, each with its own prompt and JSON schema, at low temperature (`0.1`, `num_ctx: 4096`). Each pass is a single `ollamaChat()` call with the image as a base64 attachment and a JSON schema passed as the structured-output `format`. `runPass()` parses the response, falling back to a `{...}` regex extraction if the model wraps the JSON.

| Pass | Prompt const | Schema | Output |
|---|---|---|---|
| Context | `PROMPT_CONTEXT` | `SCHEMA_CONTEXT` | `description`, `scene`, `inference` (timeOfDay, country, sourceType, sourceBrand, weather, summary) |
| Objects | `PROMPT_OBJECTS` | `SCHEMA_OBJECTS` | `objects[]` (label, confidence, area) |
| Vehicles | `PROMPT_VEHICLES` | `SCHEMA_VEHICLES` | `vehicles[]` (type, brand, model, plate, plateState, color, area) |
| Text | `PROMPT_TEXT` | `SCHEMA_TEXT` | `text[]` (value, language, type, area) |
| Safety | `PROMPT_SAFETY` | `SCHEMA_SAFETY` | `safety[]` (hazard, context, assessment, reason, area) |

`area` is constrained to a 3×3 screen-region enum (`top-left` … `bottom-right`). The context and safety passes always run; the objects, vehicles, and text passes run only when requested (or when no tasks are specified, i.e. "run all"). Known task tokens (`AnalysisTask`): `description`, `scene`, `objects`, `text`, `vehicles`, `language`.

### Safety cross-reference

After the passes complete, the merge step scans `objects[]` for weapon and fire terms (`WEAPON_TERMS`, `FIRE_TERMS`) and promotes any that the dedicated safety pass missed into `safety[]` (weapons → `critical`, fire → `concerning`), so a hazard flagged by object detection is never silently dropped. Assessment levels are `normal | concerning | critical`.

## Storage

`analysisResults` (`backend/src/db/schema.ts`):

| Column | Notes |
|---|---|
| `id` | UUID; source image saved at `data/analysis/{id}.{png\|jpg}` |
| `userId` | owner (cascade delete) |
| `path` | source image path |
| `result` | JSON of the merged `AnalysisResult` |
| `model` | VLM used |
| `tasks` | JSON `string[]` of requested tasks |
| `state` | `building \| ready \| failed` |
| `error` | failure message |
| `createdAt` | timestamp |

A `building` row is inserted before inference; it flips to `ready` (with `result`) on success or `failed` (with `error`) on any pass throwing.

## Routes (`/api/vision`)

All require auth and scope to the calling user.

| Method + path | Purpose |
|---|---|
| `GET /status` | VLM availability + model name |
| `POST /analyze` | Multipart (`image` file + optional `tasks` JSON); runs the passes, persists, returns `{ id, result, model, state }` |
| `GET /history` | Recent `ready` results (limit ≤ 50) |
| `GET /results/:id` | A single result with state/error |
| `GET /artifacts/:id` | Serve the stored source image (immutable cache) |
| `DELETE /artifacts/:id` | Delete the row and source image |

## Where it surfaces

- **Imaging page** (`frontend/src/pages/ImagingPage.tsx`): the **Recognize** tab drives `POST /api/vision/analyze` through the `useImageAnalyze` hook, letting the user pick which passes to run (objects, text, vehicles, etc.) and rendering the structured result, including safety flags.
- The VLM is also reused outside this subsystem by image generation's mid-flight `POST /api/image/preview-check`, which runs the same vision model (forced to CPU, `num_gpu: 0`) against an in-progress preview frame.

The generation queue exposes a separate `vision` slot type (alongside `chat` and `image`) so VLM passes are rate-limited independently of image generation.
