# Plan: "Save to Loki" Bookmarklet + Share-Target (`/save`)

**Status:** Approved design, not yet implemented.
**Goal:** One browser bookmarklet (and PWA share target) that captures the current page and lets the user save it into the right loki-doki app — Bookmarks, YouTube, (later) Home Inventory — through a single in-app dispatcher route `/save`.

This doc is self-contained. An implementer should be able to build the whole feature from it without re-deriving anything.

---

## 1. The core constraint (read this first — it dictates the architecture)

Auth in this app is **session cookies that are `HttpOnly` + `SameSite=Strict`**, set in `backend/src/middleware/auth.ts`:

- Cookie name `session`, HttpOnly, SameSite=Strict, Secure (auto when HTTPS), Path `/`, 7-day expiry.
- Token = 32 random bytes hex; SHA256 hash stored in DB; resolved per request.
- `requireAuth` (auth.ts:65-88) → 401 if no/expired session; sets `user` context. `requireAdmin` adds role check.
- **Cross-site rejection** (auth.ts:39-63): in production, all non-GET/HEAD/OPTIONS requests are rejected unless the `Origin` host matches the local Host header, `X-Forwarded-Host`, or `APP_ORIGIN`/`PUBLIC_ORIGIN` env. Skipped in dev.
- **CORS** (`backend/src/index.ts:193-195`): dev-only `cors({ origin: 'http://localhost:5173', credentials: true })`. **No CORS in production.**

### Why the "classic" bookmarklet is impossible here

A bookmarklet running on `reddit.com` that does
`fetch('https://my-loki/api/bookmarks', {credentials:'include'})`:

1. **SameSite=Strict** → the `session` cookie is NOT attached to a cross-site fetch. Request arrives unauthenticated → 401.
2. Even if it were attached, the **cross-site rejection** middleware blocks the POST in prod.
3. **HttpOnly** → the bookmarklet JS cannot read the cookie to forward it manually.

A bearer-token alternative (issue a long-lived token, embed it in the bookmarklet, add CORS) is rejected: it bakes a long-lived secret into a plaintext bookmark, needs new token infra, and weakens the cookie model. Do **not** go this route.

### The pattern we WILL use: navigate-to-own-origin

The bookmarklet does **not** call the API. It **opens a popup pointed at our own app** with the captured page context in query params:

```
window.open('https://YOUR-LOKI/save?url=...&title=...&text=...', 'loki_save', 'width=420,height=560')
```

That popup is a **top-level navigation to our own origin from a user gesture**, so:
- The `SameSite=Strict` session cookie **IS** sent (Strict allows top-level navigations).
- No CORS (same origin).
- No cross-site rejection (the eventual POST originates from our own `/save` page on our own origin).

The `/save` page (React, same origin, authenticated) then performs the real POST to the existing endpoints. This is how Pocket/Raindrop/Organizr-style savers work behind cookie auth.

---

## 2. Architecture overview

```
[any web page]
   │  user clicks bookmarklet (or OS share on mobile PWA)
   ▼
window.open(  /save?url=…&title=…&text=…  )   ← our origin, cookie sent
   ▼
[/save React route]  (same-origin, authenticated)
   │  detect URL type → render quick actions
   ▼
authenticated same-origin fetch() to EXISTING endpoints
   • POST /api/bookmarks
   • POST /api/youtube/save
   • PUT  /api/youtube/collections/watch-later/:videoId
   • (later) POST /api/home/devices
   ▼
toast confirmation → auto-close popup
```

`/save` is a **dispatcher**: it sniffs the incoming URL and offers the relevant action(s). Adding a new app later = add a branch to the dispatcher, not a new bookmarklet.

**No backend changes are required for the core feature** — every target endpoint already exists. (Optional niceties in §7.)

---

## 3. Backend endpoint reference (already exist — targets for `/save`)

All require the `session` cookie (`requireAuth`). Paths are under the API base (port 3000 in dev; same origin in prod).

### Bookmarks — `backend/src/routes/bookmarks.ts`
- **Create personal bookmark**: `POST /api/bookmarks`
  body: `{ label: string, url: string, icon?: string, category?: string, useProxy?: boolean, useEmbed?: boolean }` (bookmarks.ts:94-115; ownerId = user.id)
- **Probe URL** (for auto title/favicon): `GET /api/bookmarks/probe?url=...` → checks frame-blocking headers, extracts favicon (bookmarks.ts:14-66)
- List: `GET /api/bookmarks` (global + personal)
- Global/admin create (admin only): `POST /api/admin/bookmarks` — `backend/src/routes/adminBookmarks.ts:15-35`, same fields, ownerId=null.

### YouTube — `backend/src/routes/youtube.ts`
- **Save offline (queues download job)**: `POST /api/youtube/save`
  body: `{ videoId: string, kind?: 'audio'|'video', title?: string, maxHeight?: number, audioFormat?: 'm4a'|'mp3' }` (youtube.ts:439-461). videoId validated as ~11-char YouTube id (youtube.ts:445).
- **Add to collection**: `PUT /api/youtube/collections/:key/:videoId` where key ∈ `watch-later` | `liked`
  body (optional): `{ title?, author?, channelId?, durationSec? }` (youtube.ts:1264-1285)
- Remove: `DELETE /api/youtube/collections/:key/:videoId` (youtube.ts:1287-1295)
- List collections: `GET /api/youtube/collections` (youtube.ts:1248-1262)
- Export (yt-dlp, returns jobId): `POST /api/youtube/export` (youtube.ts:547-581)

### Podcasts — `backend/src/routes/podcasts.ts`
- No direct "create podcast from a YouTube URL" endpoint. Shows are created (`POST /api/podcasts/shows`, podcasts.ts:161+) then episodes generated (`POST /api/podcasts/shows/:id/generate`, podcasts.ts:497-548). **Out of scope for v1** — see §7 for the optional reverse-link route that already exists (`/api/podcasts/by-video/:videoId`, see memory `project_youtube_redesign`).

### Home Inventory — `backend/src/routes/home.ts`
- `POST /api/home/devices` takes **FormData** (name, category, brand, model, serialNumber, owner, description, photo, …) (home.ts:48-100). No URL import. **Phase 2.**

### Server entry — `backend/src/index.ts`
- Hono on Bun. Port 3000 (index.ts:280, `PORT` overridable). Routes registered in index.ts. Health: `GET /api/health` (no auth, index.ts:201).

---

## 4. URL detection / dispatch logic

Implement a pure helper, e.g. `frontend/src/lib/saveTarget.ts`:

```ts
export type SaveKind =
  | { type: 'youtube'; videoId: string }
  | { type: 'link' };

export function detectSaveTarget(rawUrl: string): SaveKind {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { type: 'link' }; }
  const host = url.hostname.replace(/^www\./, '');

  // youtu.be/<id>
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    if (isYtId(id)) return { type: 'youtube', videoId: id };
  }
  // youtube.com/watch?v=<id>, /shorts/<id>, /live/<id>, /embed/<id>
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v');
    if (isYtId(v)) return { type: 'youtube', videoId: v! };
    const m = url.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
    if (m && isYtId(m[2])) return { type: 'youtube', videoId: m[2] };
  }
  return { type: 'link' };
}

const isYtId = (s: string | null | undefined): s is string =>
  !!s && /^[\w-]{11}$/.test(s);
```

(There may already be a YouTube id parser in the YouTube sub-app — search `frontend/src` for one and reuse rather than duplicate, per the project's component-reuse preference. Check `lib/youtube` / the youtube redesign code referenced in memory `project_youtube_redesign`.)

---

## 5. The `/save` route (frontend)

**Stack reminder** (see `agents.md` / memory `project_stack`): React + TS + Vite + Tailwind v4 + shadcn, Bun. Reuse shared components in `frontend/src/.../shared/`. **Never** use `window.confirm/alert/prompt` (memory `feedback_no_browser_popups`) — use shared `ConfirmDialog` + toast.

### Where to register
Find the app router (search for existing route definitions, e.g. `createBrowserRouter` or `<Routes>` in `frontend/src`). Add a route `path: '/save'`. It must render inside the authenticated shell so that an unauthenticated hit redirects to login and bounces back to `/save?...` (preserve query string through the login redirect — verify the existing login redirect does this; if not, handle it).

### Component behavior — `frontend/src/pages/SavePage.tsx` (or matching convention)
1. Parse `url`, `title`, `text` from `useSearchParams()`.
2. `const target = detectSaveTarget(url)`.
3. Render a compact popup-sized card (popup is 420×560):
   - Header: favicon + page title (editable text input pre-filled with `title`).
   - Show the URL (truncated).
   - **Action buttons depend on `target.type`:**
     - `youtube`:
       - "Save offline (video)" → `POST /api/youtube/save` `{ videoId, kind:'video', title }`
       - "Save offline (audio)" → `POST /api/youtube/save` `{ videoId, kind:'audio', title }`
       - "Watch later" → `PUT /api/youtube/collections/watch-later/{videoId}` `{ title }`
       - "Add as bookmark" (fallback, always available) → `POST /api/bookmarks`
     - `link`:
       - "Add bookmark" → `POST /api/bookmarks` `{ label: title, url, category? }`
       - Optional category `<select>` (reuse the categories surfaced by `GET /api/bookmarks`).
       - Optionally call `GET /api/bookmarks/probe?url=` on mount to auto-fill a better title/favicon if `title` is empty.
4. All fetches: same-origin, `credentials: 'include'` (or whatever the existing API client uses — **reuse the project's API wrapper/fetch helper**, search `frontend/src` for the existing `api`/`fetchJson` client rather than raw fetch).
5. On success: shared toast "Saved ✓", then `setTimeout(() => window.close(), 800)`. If `window.close()` is blocked (page not opened by script), show a "You can close this tab" state instead.
6. On 401: redirect to login preserving the full `/save?...` URL as the post-login return.
7. Errors: toast with the server message; keep the popup open so the user can retry.

### Popup sizing / UX
- Design for 420×560. Single column, big tap targets. No nav chrome needed — consider a minimal layout variant (no sidebar) for `/save` so it reads as a focused dialog. Check how other full-screen/standalone routes (e.g. ReaderPage at `/read/:sourceId`, memory `project_zim_library`) opt out of the main shell and mirror that approach.

---

## 6. The bookmarklet + install UI

### Bookmarklet source (minified into an `href`)
```js
javascript:(function(){
  var u=encodeURIComponent(location.href);
  var t=encodeURIComponent(document.title);
  var s=encodeURIComponent((''+(window.getSelection?window.getSelection():'')).slice(0,500));
  var w=window.open(ORIGIN+'/save?url='+u+'&title='+t+'&text='+s,'loki_save',
    'width=420,height=560,menubar=no,toolbar=no');
  if(w)w.focus();
})();
```
- `ORIGIN` must be the user's actual app origin. **Generate it dynamically** in the install UI from `window.location.origin` so it's correct for every deployment (do not hardcode).

### Install UI — Settings panel "Save to Loki"
- Add a section (likely under Settings; check how other Settings panels are registered — memory `project_admin_nav` covers admin registry, but this is a *user* setting so find the user Settings page).
- Render a draggable `<a>` whose `href` is the bookmarklet with `ORIGIN` interpolated, label "Save to Loki". Users drag it to their bookmarks bar.
- Instructions: "Drag this button to your bookmarks bar. On any page, click it to save to Loki." Plus a note that the popup may need popup-permission the first time.
- Optional: a copy-to-clipboard of the bookmarklet code for browsers that block dragging.

**Gotcha:** React/JSX will not let you put `javascript:` in an `href` cleanly and some bundlers/sanitizers strip it. Set it via a ref after mount (`ref.current.setAttribute('href', code)`) or build the anchor with `dangerouslySetInnerHTML`. Test that the dragged bookmark actually contains the JS.

---

## 7. PWA Web Share Target (folds mobile into the same code path)

If a web manifest exists (search `frontend` for `manifest.webmanifest` / `manifest.json` / vite-plugin-pwa config):

Add:
```json
"share_target": {
  "action": "/save",
  "method": "GET",
  "params": { "title": "title", "text": "text", "url": "url" }
}
```
Then when the app is installed as a PWA, the OS share sheet lists "Loki" and feeds the identical `/save` route. Desktop bookmarklet + mobile share = one implementation.

If no manifest/PWA setup exists, this is optional and can be skipped in v1 (note it as a follow-up).

---

## 8. Scope / phasing

**v1 (build this):**
- `detectSaveTarget` helper (reuse existing YT id parser if present).
- `/save` route + `SavePage` component, standalone layout, auth-gated with query-preserving login redirect.
- Actions: Bookmarks (link) + YouTube (save offline video/audio, watch-later). Bookmark fallback always available.
- Settings "Save to Loki" panel with dynamic-origin bookmarklet.
- PWA `share_target` **if** a manifest already exists.

**Phase 2 (later, note only):**
- Home Inventory "save from URL" — needs a new backend flow (current `POST /api/home/devices` is FormData/photo-based, no URL import). Would likely need VLM/web-lookup wiring (memory `project_home_inventory`).
- Podcast "make podcast from this video" — reuse podcast generate flow; reverse-link route `/api/podcasts/by-video/:videoId` exists (memory `project_youtube_redesign`).
- Global/admin bookmark option (admin-only button → `POST /api/admin/bookmarks`).

---

## 9. Acceptance criteria

1. Dragging the Settings bookmarklet to the bookmarks bar, then clicking it on:
   - a YouTube watch page → popup offers Save offline (video/audio) + Watch later + Add bookmark; chosen action succeeds and the video appears in the YouTube offline library / watch-later.
   - any other page → popup offers Add bookmark; saved bookmark appears in `GET /api/bookmarks` and on the Links page.
2. Clicking the bookmarklet while logged out → lands on login → after login returns to `/save?...` with params intact and completes.
3. Popup auto-closes ~0.8s after a successful save; errors keep it open with a toast.
4. No use of `window.confirm/alert/prompt`; uses shared toast/ConfirmDialog.
5. Works in production cookie mode (SameSite=Strict) because all writes are same-origin from `/save`. Verify no CORS or cross-site-rejection errors in the network tab.
6. Bookmarklet `ORIGIN` is generated from `window.location.origin`, correct on any deployment.

---

## 10. Key files to touch / create

Create:
- `frontend/src/lib/saveTarget.ts` — URL detection (or colocate per project convention).
- `frontend/src/pages/SavePage.tsx` (match existing page naming/location).
- Settings panel component for the bookmarklet (find existing Settings page structure first).

Edit:
- Frontend router — register `/save` (standalone/auth-gated).
- Web manifest — add `share_target` (if manifest exists).
- `agents.md` component catalog — add new shared pieces if any are generalized (memory `feedback_components`).

Reuse (do not duplicate — search first):
- Existing API/fetch client in `frontend/src`.
- Existing YouTube id parser (youtube sub-app).
- Shared toast + ConfirmDialog + layout-opt-out pattern (see ReaderPage `/read/:sourceId`).

No backend edits for v1.

---

## 11. Reference: why each anti-pattern was rejected

- **Background fetch from foreign origin** → blocked by SameSite=Strict + cross-site rejection + HttpOnly. Dead end.
- **Bearer token in the bookmarklet** → long-lived secret in plaintext bookmark, new token infra, weakens cookie model. Rejected.
- **Adding production CORS allowlist for arbitrary origins** → you can't enumerate "every site the user might be on"; and it still doesn't solve SameSite/HttpOnly. Rejected.

The navigate-to-own-origin `/save` dispatcher is the only approach that works cleanly under the existing auth model and unifies all apps behind one bookmarklet.
