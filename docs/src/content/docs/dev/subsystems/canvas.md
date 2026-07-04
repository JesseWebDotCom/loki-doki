---
title: Canvas / Artifacts
description: The editable side pane the companion writes code/documents/HTML into, streamed live via the turn pipeline.
sidebar:
  order: 2.5
---

## Overview

Canvas is a single-file, editable output surface for the companion, a lighter-weight sibling of [Coding](../coding/) (which is for multi-file projects that need to actually run). The chat tool that opens one (`backend/src/tools/canvas.ts`) is explicit about the boundary: Canvas is for one self-contained artifact, code snippet, markdown document, or small HTML page, never a multi-file build.

Key files:

- `backend/src/lib/artifacts/store.ts`: create/version/read/export, the single write path both the tool and the HTTP route go through
- `backend/src/lib/artifacts/export.ts`: md/txt/html/pdf export (PDF reuses the Playwright renderer shared with the Reader archive engine)
- `backend/src/tools/canvas.ts`: the `canvas` chat tool (open + edit modes)
- `backend/src/routes/artifacts.ts`: CRUD + export HTTP routes, mounted at `/api/artifacts`
- `backend/src/lib/companionTurn.ts`: streams the artifact body live as `artifact_token` SSE events
- `frontend/src/pages/CanvasPage.tsx`: the `/canvas` tray of all artifacts
- `frontend/src/components/canvas/{ArtifactPane,CanvasEditor}.tsx`: the live pane + editor
- `frontend/src/components/chat/blocks/ArtifactBlock.tsx`: the in-chat card that opens the pane
- `frontend/src/lib/canvas/artifactStore.ts`: frontend state for the open artifact
- Tables: `artifacts`, `artifactVersions`

---

## Data model

`artifacts`: `type` (`'code' | 'document' | 'html'`), `language` (for code), `title`, `currentContent` (denormalized latest body for fast reads), `pinned`, `archivedAt`, plus the `conversationId`/`messageId` it originated from.

`artifactVersions`: one **immutable** row per revision, `author` (`'assistant' | 'user'`) distinguishes the companion's generations/edits from the user's own hand edits, plus an optional human-readable `summary` (e.g. "Made the function async"). `currentContent` on the parent row is a denormalized cache of the latest version's content.

---

## Opening an artifact (`canvas` tool)

The tool has two modes:

- **Create** (`type`/`title`/`language` args): calls `createArtifact()` with an empty body, then returns a `directive: { action: 'open_artifact', artifactId, artifactType, title }`. The tool does **not** write the content itself, that's the job of the LLM synthesis pass that follows in the same turn, per an `outputRuleFor()` instruction (e.g. "output ONLY the raw code, no markdown fences, no prose") so the model's raw output IS the artifact body.
- **Edit** (`editArtifactId`/`instruction` args, set by a focused-canvas override in `companionTurn.ts`, never chosen by the model itself): loads the existing artifact and reuses the same `open_artifact` directive (in case the pane was closed), with a `synthesisHint` that hands the model the current content plus the requested change and asks for the **full updated body** back.

---

## Streaming into the pane

`companionTurn.ts` defines the SSE event set including `artifact_token` and `artifact_done`. When a turn's tool result carries an `open_artifact` directive, the LLM synthesis pass that follows IS the artifact body: the turn pipeline tees each token into an `artifact_token` event (`{ artifactId, token }`) as it's generated, so the frontend pane fills in live, in lockstep with the same tokens that would otherwise stream into the chat bubble. The synthesis pass's full output is what gets persisted as the artifact's first (or next) `artifactVersions` row.

A conversation tracks its currently-open artifact (`chat.ts`) so a plain follow-up message ("make it shorter") can be routed as an edit-style turn targeting that artifact without the user having to name it again.

---

## Routes (`backend/src/routes/artifacts.ts`, all `requireAuth`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | List the user's artifacts (the `/canvas` tray) |
| `GET` | `/:id` | Fetch one artifact |
| `POST` | `/` | Create (used by non-tool creation paths) |
| `PUT` | `/:id` | User hand-edit, appends a `user`-authored version |
| `POST` | `/:id/edit` | LLM edit pass over the current content (used outside the chat-turn flow) |
| `POST` | `/:id/revert` | Roll back to an earlier version |
| `DELETE` | `/:id` | Archive (soft-delete via `archivedAt`) |
| `GET` | `/:id/export?format=` | Export to `md` / `txt` / `html` / `pdf` |

---

## Export

`exportArtifact()` (`lib/artifacts/export.ts`) handles plain text/markdown/HTML directly; PDF export renders through the same headless Chromium instance (Playwright) that powers the Bookmarks Reader archive engine, install-heals if Chromium is missing (see `backend/src/routes/system.ts`).
