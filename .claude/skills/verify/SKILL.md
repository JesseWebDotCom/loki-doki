---
name: verify
description: Runtime-verify a frontend/backend change by driving the real app (including the /hud dock island) in a headless browser against an isolated backend. Use after nontrivial UI or API changes, before committing.
---

# Verify a change against a throwaway instance

Drive the real app in headless Chromium against an isolated backend so nothing
touches the owner's `data/` directory. Cold-start recipe that worked (2026-07):

## Launch (isolated, no Docker)

```bash
SCRATCH=$(mktemp -d)   # or the session scratchpad
# Backend: NODE_ENV=development is REQUIRED or every non-GET from the vite
# origin is rejected 403 "Cross-site request blocked" (see middleware/auth.ts).
cd backend && NODE_ENV=development DATABASE_URL=$SCRATCH/data/app.db PORT=3000 \
  PIN_PEPPER_SECRET=$(printf 'a%.0s' {1..64}) bun src/index.ts &
cd frontend && bun x vite --port 5173 &
```

Migration "no such table" warnings on a fresh DB are noise; the server still
comes up.

## Seed a session with curl (fresh DB)

```bash
# Create admin; -c saves the auto-issued session cookie
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"firstName":"Demo","lastName":"Admin","birthdate":"1990-01-01","pin":"1234"}' \
  http://localhost:3000/api/setup/admin
# Without these two, the app shows the setup wizard / "Sign in" pill instead of content
curl -b cookies.txt -X POST http://localhost:3000/api/setup/finish
curl -b cookies.txt -X POST http://localhost:3000/api/setup/welcome-complete
```

Enable and configure tools via `PUT /api/tools/:id/enabled` and
`PUT /api/tools/config/global {toolId,key,value}`; per-user prefs via
`PATCH /api/users/:id/preferences`.

## Playwright

Borrow the backend's playwright; browsers are pre-installed in the repo's
managed dir (this is what `lib/playwrightEnv.ts` pins for the server):

```js
process.env.PLAYWRIGHT_BROWSERS_PATH = '<repo>/data/bin/playwright'  // or export before bun
const { chromium } = await import('<repo>/backend/node_modules/playwright/index.mjs')
await ctx.addCookies([{ name: 'session', value: TOKEN, domain: 'localhost', path: '/' }])
```

Run scripts with `bun script.mjs` (no node on this machine). Use
`waitUntil: 'load'` plus a fixed wait, never `networkidle` (the app polls
forever).

Gotcha: on first visit the main app shows the "Where are you?" location
onboarding; click the "Skip for now" text before looking for page content.

## Driving the dock island at /hud

The island is a tier machine: compact -> peek (hover ~300ms) -> full (click on
a non-interactive area). Reliable expansion loop:

```js
await page.mouse.move(450, 20); await page.waitForTimeout(600)
for (const [x, y] of [[450, 20], [500, 30], [560, 100]]) {
  if (await someFullOnlyControl.isVisible().catch(() => false)) break
  await page.mouse.click(x, y); await page.waitForTimeout(900)
}
```

Island tabs are icon buttons reachable by `getByRole('button', { name: '<Label>' })`.

## Mock Home Assistant

For HA-dependent surfaces, a ~120-line Bun mock suffices: WS at
`/api/websocket` speaking `auth_required/auth/auth_ok`, replies to
`config/{area,device,entity}_registry/list` and `subscribe_entities`
(result + `{event:{a:{...}}}` seed), plus REST
`POST /api/services/:domain/:service` (Bearer token) that mutates state and
pushes `{event:{c:{eid:{'+':{s,a}}}}}` to subscribers. Point the tool config
`base_url` at it (e.g. `http://localhost:8123`).
