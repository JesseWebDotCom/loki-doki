---
name: update-docs
description: Refresh README.md and the Starlight user docs (docs/src/content/docs/user/) with the latest shipped features and privacy-safe screenshots taken as the seeded demo household. Use when features shipped since the last docs update, or when the user asks to update the docs, README, or screenshots.
---

# Update the docs with fresh features + screenshots

Refresh the README and user docs so they describe the latest shipped features, with
screenshots that contain ONLY demo-household data — never the owner's real profiles,
history, or location.

## How screenshots stay privacy-safe (do not weaken any layer)

1. **Demo household**: `backend/scripts/seed-demo.ts` seeds 4 fictional users (the
   Parkers — fixed `dde30000-…` UUIDs) with real public media but invented identities
   and a generic location (Portland, OR). Screenshots are taken only as these users, so
   the owner's per-user data is structurally invisible to the capture.
2. **Session guard**: `frontend/scripts/docs-screenshot.mjs` reads sessions ONLY from
   the gitignored `frontend/scripts/.demo-sessions.json` and verifies each against
   `/api/auth/me` (id must match and carry the `dde30000-` prefix). Never add an env
   token override or point it at a real session.
3. **Denylist**: every captured page's visible text is scanned against the gitignored
   `.demo-denylist.txt` (repo root: owner names, city, real profile names). A hit skips
   the PNG and fails the run. NEVER remove terms just to make a run pass — investigate
   the hit first. A term may legitimately be a false positive from live content (e.g. a
   trending sports video mentioning a state name); only then is narrowing it OK, and
   say so in your report.

## Workflow

### 1. Preflight (hard gates — stop and tell the user if any fail)

- `curl -sf http://localhost:5173/ >/dev/null && curl -sf http://localhost:3000/api/health >/dev/null`
  — both dev servers must be up.
- `.demo-denylist.txt` exists at the repo root and has at least one non-comment line.
  (A missing file is auto-bootstrapped from real profiles by the seed script in step 4;
  an empty one means something is wrong — stop and ask.)
- `backend/node_modules/playwright` exists.

### 2. Discover what changed

```bash
LAST=$(git log -1 --format=%H -- docs/src/content README.md)
git log --oneline --no-merges "$LAST"..HEAD
git diff --stat "$LAST"..HEAD -- backend/src frontend/src
```

Map the changes to docs pages: routes live in `frontend/src/App.tsx`; each user-facing
app has a page at `docs/src/content/docs/user/features/<slug>.md` (sidebar is
auto-generated — a new file just appears). Skim the relevant memory/agents.md notes so
the prose describes behavior, not implementation.

### 3. Update prose

- README.md: feature tables use the existing HTML `<table>` + `assets/icons/*.svg`
  pattern; match its tone (privacy-first, family-first — protecting kids and seniors,
  never "convenience"/"ad-skipping" framing).
- Feature pages: copy frontmatter shape from an existing page in
  `docs/src/content/docs/user/features/`.

### 4. Seed the demo household (always — fresh users AND fresh session tokens)

```bash
cd backend && bun run seed:demo
```

### 5. Screenshots

- If a new/changed page needs a shot, add an entry to
  `frontend/scripts/docs-shot-manifest.mjs` (route, persona, name, optional
  `selector` for element-scoped shots, `actions` for pre-shot clicks/waits).
  Persona guide: admin/parental surfaces → `sam`; kid views → `jamie`; teen → `riley`;
  news/radio/classics → `rose`. For admin pages, prefer an element-scoped `selector` —
  full admin pages show the real household's global state.
- Run `cd frontend && bun run shots:docs` (pass name filters to re-shoot a subset).
- On a non-zero exit, report the DENYLIST HIT / failed-action lines verbatim and STOP.
- The README masthead is `home-desktop.png` used directly — no compositing. Keep it a
  plain single-app screenshot (owner preference); mobile shots are separate images.

### 6. Embed

Screenshots land in `docs/src/assets/screenshots/<name>-<variant>.png`.

- Feature page (`user/features/*.md`): `![alt](../../../../assets/screenshots/<file>)`
  placed right after the intro paragraph. Top-level user pages (`user/*.md`) use one
  fewer `../`.
- README: `<img src="docs/src/assets/screenshots/<file>" width="880">` (renders on
  GitHub via the repo-relative path).
- Orphan check both directions: every referenced screenshot exists on disk, and every
  PNG in the screenshots dir is referenced somewhere (README or docs). Report strays.

### 7. Verify

```bash
cd docs && bun run build   # Astro fails the build on any broken image path
```

### 8. Tear down the demo household (ALWAYS — even if earlier steps failed)

```bash
cd backend && bun run seed:demo:reset
```

The demo users are ephemeral by design: they must not linger on the family's login
picker after the docs run.

### 9. Report

List: pages added/updated, screenshots taken/re-taken/skipped, denylist status, and
confirm teardown ran. Do NOT commit unless the user asks.

## Hard rules

- Screenshots only via `bun run shots:docs` with seeded demo sessions — never capture
  a browser logged in as a real user, and never bypass the engine's guards.
- Never commit `.demo-sessions.json` or `.demo-denylist.txt` (both gitignored — keep
  them that way).
- Never put the owner's real name, family names, city, or history into
  `backend/scripts/seed-demo-data.ts`, alt text, captions, or example prose. Demo
  content is real public media + fictional people only.
- If the `/api/auth/me` guard trips or sessions are stale, rerun
  `cd backend && bun run seed:demo` — do not work around it.
