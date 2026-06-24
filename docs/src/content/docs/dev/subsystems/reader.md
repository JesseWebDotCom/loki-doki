---
title: Links
description: Organizr-style bookmarks with global and personal scopes, an embedded iframe viewer, and a same-origin reverse proxy.
sidebar:
  order: 14
---

## Overview

The Links page is an Organizr-style bookmark launcher. It supports **global bookmarks** (admin-managed, visible to all users) and **personal bookmarks** (per-user). Bookmarks can open in a new tab or embed inside the app via an iframe viewer; embedded sites that block framing can be served through a same-origin reverse proxy.

---

## Data Model

The `bookmarks` table (`backend/src/db/schema.ts`):

```ts
bookmarks
  id          text  primary key
  ownerId     text  → users.id (onDelete: cascade); NULL = global
  label       text  not null
  url         text  not null
  icon        text  nullable (favicon URL, or a named-icon key)
  category    text  not null, default 'Other'
  sortOrder   integer  not null, default 0
  useProxy    integer (boolean)  not null, default false
  useEmbed    integer (boolean)  not null, default false
  createdAt   integer (timestamp)
  updatedAt   integer (timestamp)
```

Global bookmarks have `ownerId = null`; personal bookmarks are scoped to `ownerId = user.id`.

Per-user hiding of global bookmarks is **not** a column. It lives in `user_preferences` under the key `bookmarks.hidden` as a JSON array of bookmark ids.

---

## Routes

### `/api/bookmarks` (`backend/src/routes/bookmarks.ts`, `requireAuth`)

- `GET /probe?url=...`: registered before `/:id`. Uses `safeFetch` (SSRF-guarded against internal/loopback/metadata ranges, including redirect hops) to report `{ reachable, framesBlocked, faviconUrl }`. `framesBlocked` is derived from `X-Frame-Options` or a `frame-ancestors` CSP directive; the favicon is parsed from the HTML `<link rel=icon>` or falls back to `/favicon.ico`.
- `GET /`: returns global + this user's bookmarks. Each row is decorated with `isGlobal` (`ownerId === null`), `canEdit` (`ownerId === user.id`), and `isHidden` (global and present in the user's `bookmarks.hidden` list).
- `POST /`: create a personal bookmark (`ownerId = user.id`, default category `Other`).
- `PATCH /:id` / `DELETE /:id`: update/delete, scoped to `ownerId = user.id` (404 otherwise).
- `PUT /hide/:id` / `DELETE /hide/:id`: add/remove a global bookmark id from the user's `bookmarks.hidden` preference.

### `/api/admin/bookmarks` (`backend/src/routes/adminBookmarks.ts`, `requireAdmin`)

- `GET /` lists global bookmarks (`ownerId IS NULL`); `POST /` creates them (`ownerId = null`, default category `Services`); `PATCH /:id` / `DELETE /:id` edit/delete by id with no owner scoping.

### `/api/proxy` (`backend/src/routes/proxy.ts`, `requireAuth`)

Transparent reverse proxy used when `useProxy` is on. `GET /:id` fetches the exact bookmark URL; `GET /:id/*` fetches `targetOrigin/<subpath>`. Authorization: the bookmark must be global or owned by the caller (403 otherwise). The target is `assertPublicUrl`-guarded (SSRF) since bookmark URLs are user-controlled and the server sits next to Ollama/ComfyUI/router admin.

For HTML responses it injects `<base href="/api/proxy/:id/">`, strips inline CSP `<meta>` tags, and rewrites same-origin absolute URLs and absolute paths in `href`/`src`/`action` and CSS `url(...)` to stay within the proxy. Frame-blocking headers are stripped **only** when not `X-Frame-Options: DENY` (a hard DENY is passed through so the browser still refuses); `SAMEORIGIN` is safe to strip because the proxy serves from our origin. Redirects to the same origin are rewritten back into proxy paths.

All three routers are mounted in `backend/src/index.ts` at `/api/bookmarks`, `/api/admin/bookmarks`, and `/api/proxy`.

---

## LinksPage (`frontend/src/pages/LinksPage.tsx`)

Route `/links`. Loads `GET /api/bookmarks`, derives the category list, and renders a responsive grid grouped by category, sorted by `sortOrder` then label. Each card:

- If `useEmbed`, links to `/links/:id` (the embedded viewer); otherwise it's an `<a target="_blank">`.
- Shows an `ExternalLink` button always, plus `Pencil`/`Trash2` when `canEdit`.
- Hidden global bookmarks render at reduced opacity.

The add/edit dialog (`BookmarkFormDialog`) debounces a call to `/api/bookmarks/probe` on URL change: it auto-fills the icon from the discovered favicon and auto-enables `useProxy` when the probe reports `reachable && framesBlocked`. Admins get a **Manage global** link to `/admin/links`.

---

## LinkViewPage (`frontend/src/pages/LinkViewPage.tsx`)

Route `/links/:id`. The embedded iframe viewer. `src` is `bookmark.url` normally, or `/api/proxy/:id` when `useProxy` is set. Chrome bar:

- **Back / Forward** drive `iframe.contentWindow.history` (best-effort; cross-origin frames may not cooperate).
- **Reload** remounts the iframe via a key bump.
- **Proxy toggle** (⇄) PATCHes `useProxy` on the bookmark, then reloads.
- **Open in new tab** escape hatch.

It best-effort injects an inverting CSS filter into the iframe document for dark theme (wrapped in try/catch; cross-origin frames silently skip). On `onError` it shows a fallback with **Try again** and **Open directly**.

---

## Admin: AdminLinksTab (`frontend/src/components/admin/AdminLinksTab.tsx`)

Reached at `/admin/links`. Lists global bookmarks grouped by category and reuses the same probe-driven form dialog as LinksPage. Supports add / edit / delete of global bookmarks. There is no drag-and-drop reorder; `sortOrder` exists in the schema but is not edited from this tab.

---

## Personal Bookmarks

Users add their own from LinksPage via `POST /api/bookmarks`. They are scoped to `ownerId` and never visible to other users or admins. Users can also hide (not delete) any global bookmark for themselves via the `bookmarks.hidden` preference.
