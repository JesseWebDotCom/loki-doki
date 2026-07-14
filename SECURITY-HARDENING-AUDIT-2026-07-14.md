# Security Hardening Audit — 2026-07-14

Scope: review of the external "capability gate" proposal, plus an independent, broader
audit framed around protecting the operator, their systems, their data, their household
members, and their home from harm — technical, privacy, and legal.

Method: five parallel evidence-based passes (feature-gate enforcement, injection/SSRF/RCE,
auth/network/tokens, secrets-at-rest, and legal/privacy/desktop), each verified against
current `backend/src` / `frontend/src` / `desktop/` with file:line citations, and
cross-checked against the prior `AUDIT-2026-07-11.md` to distinguish fixed from open.

---

## Part 1 — Verdict on the proposed "capability gate" work

**The diagnosis is correct.** I confirmed it firsthand: the Admin feature toggles are
UI-only. `getFeatureMap()` (`routes/appFeatures.ts:18`) is dead code with no callers; it
covers just 3 apps (bookmarks, home-inventory, notes) and even those are not enforced.
Every route is mounted unconditionally in `index.ts:494-629`; every poller starts
unconditionally in the boot block (`index.ts:199-411`). There is no `requireFeature` /
`isFeatureEnabled` helper anywhere.

The one real gating that exists — `isToolAllowed` / `getAllowedToolIds`
(`lib/toolConfig.ts`) — operates **only at the companion's LLM tool-routing layer**. It
decides which tools the chatbot may call. It does **not** gate the HTTP routes, the
WebSocket upgrades, the pollers, or the token endpoints. So "disable Remote" stops the
chatbot from invoking SSH but leaves `/api/remote/*` and the SSH/VNC/RDP WebSocket fully
live to any authenticated member who calls the API directly. That is exactly the
false-sense-of-safety the proposal describes.

**The proposed architecture is sound** — a central backend gate, enforced at
route + WebSocket + poller + job-enqueue + token layers; separating installed / visible /
enabled; default-off for risky features; PIN to enable critical ones; audit logging. Build
it.

**Three corrections to the framing, though:**

1. **A feature gate is necessary but not the most urgent work, and it is not sufficient.**
   The proposal optimizes "disabled means truly off." But the larger risk in this codebase
   is "**enabled means unsafe**." Several capabilities are exploitable *right now* by an
   ordinary authenticated household member — including a PIN-less child profile — with the
   feature fully enabled. A global on/off switch does nothing for those. Fix the live holes
   first (Part 2, P0), then build the gate.

2. **The right control is least-privilege per profile, not a household-global boolean.**
   Example: even with `remote` "enabled," any authenticated non-admin can open SSH to a
   shared host and be handed the decrypted VNC/RDP password, unaudited
   (`remote.ts:289-297`, `canAccessHost` returns true for any shared host). Gating the
   whole feature on/off for the household doesn't address that a kid's profile can reach a
   shell. The gate needs a **per-profile capability** dimension (may-use-terminals,
   may-use-remote), not just admin-global enable.

3. **Don't build a parallel `feature_flags` table from scratch — unify what already
   exists.** The codebase already has (a) `lib/consent.ts` with `internet` OFF by default
   gating all network tools plus a liability waiver, (b) the `__enabled` / `__chat_enabled`
   tool-config flags, and (c) per-profile content clamps that *are* server-enforced. The
   work is to extend those concepts **down to the HTTP boundary**, not to invent a fourth
   overlapping system. Reuse `toolConfig`'s flag storage + the consent model; add the route
   middleware and poller guards the proposal describes.

Everything else in the proposal (coverage list, job-queue gating, revoke-tokens/stop-jobs
controls, the "why is this still running?" admin view, tests for direct route access) I
agree with as written.

---

## Part 2 — Independent findings, ranked by real-world risk

Severity is calibrated to the operator's goal (protect systems/data/household/home), not to
CVSS. "Reachable by" states who can exploit it under the app's own trust assumptions.

### P0 — Live-exploitable now (do these before the gate)

**P0-1 — Remote code execution via `POST /api/clipper/save` (argument injection).**
`routes/clipper.ts:33-64` accepts `body.url`, checks only that it is non-empty, and enqueues
it. `lib/clipper/download.ts:109,111` pass it to yt-dlp as a **bare positional arg with no
`--` terminator and no `assertPublicUrl`**. `{"url":"--config-location=<path>"}` makes
yt-dlp load an attacker-controlled config (a deterministic `data/drops/` path is writable
via `/api/drop`) whose `--exec` runs arbitrary commands as the backend user — which owns the
SQLite DB with every stored secret. The prior audit's C2 fix was applied to `/resolve` and
`/stream` but **missed the `/save` → download path.** Also a readable SSRF
(`url=http://169.254.169.254/…` is fetched and returned via `/api/clipper/file/:clipId`).
Reachable by: any authenticated member. **Fix: `^https?://` check + `assertPublicUrl` +
`'--'` before the URL in `download.ts`.**

**P0-2 — Unauthenticated admin takeover of any PIN-less admin profile.**
`POST /api/auth/select` (`routes/auth.ts:36-75`, no auth middleware) will, for an admin
profile with no PIN row, accept a caller-supplied PIN, set it, and immediately issue an
**admin session**. `GET /api/auth/profiles` (unauthenticated, `auth.ts:15-33`) hands the
attacker the roster plus a `hasPin` flag to find the target. First-run
(`routes/setup.ts:92`) creates the admin **with no PIN** and nothing ever forces one. On an
exposed instance this is one-request full compromise. Reachable by: anyone who can reach the
origin. **Fix: never issue an admin session from an unauthenticated endpoint; force PIN
setup at first-run; drop `hasPin`/names from the unauthenticated roster.**

**P0-3 — Unauthenticated living-room camera feed.** `GET /api/pod/camera-test` and its
stream (`routes/pod.ts:225-256`) serve the actual Frigate camera with **no auth and no
device key at all**. The per-device display/photo/now-playing endpoints
(`pod.ts:66-218`) are keyed only by MAC (enumerable — public OUI prefixes, MACs leak on the
LAN) and never check the device token they mint at pairing. Reachable by: anyone who can
reach the origin. **Fix: authenticate these with the already-minted (hashed) device token;
gate `/camera-test*` behind `requireAuth`.**

**P0-4 — Child-safety enforcement is largely client-side / bypassable.** Three concrete
holes:
- `blockAdultImages` is defined and defaulted-true for children
  (`protections.ts:12`, `users.ts:84`) but has **zero enforcement reads** —
  `/api/image/generate` (`routes/image.ts:1356`) is `requireAuth` only. A child profile can
  generate explicit imagery directly.
- The CSAM prompt screen (`screenPrompt`, `image.ts:1399`, commented "NOT bypassable")
  exists only on the HTTP `/generate` handler. The companion image/video tools
  (`tools/imageGen.ts:68`, `tools/videoGen.ts:76`) and book generation
  (`lib/books/generate/commit.ts:36`) call `startImageJob` directly and **skip the screen.**
  This is operator legal exposure, not just a policy gap.
- Adult-content "reveal" (`routes/privacy.ts:34-79`) sets **no server session state** —
  hidden/revealed is pure React state; APIs return adult items with an `isAdult` flag and
  filter client-side, so a direct API call bypasses the PIN veil.

Reachable by: any child/non-admin profile. **Fix: enforce `blockAdultImages` server-side on
the generate route against the requesting profile; route every image/video entry point
through `screenPrompt`; make the privacy reveal a server-side session capability.**

### P1 — Serious (fix soon; several are the "enabled means unsafe" class the gate won't cover)

**P1-1 — Secrets are mostly plaintext at rest, and the encryption key lives in the same DB.**
Only the SSH/VNC/RDP host table is encrypted (AES-256-GCM via `lib/secrets.ts`). **Plaintext:**
Plex token, Home Assistant long-lived token, Telegram bot token, SMTP password, YouTube OAuth
access+refresh+clientSecret, OPDS/Calibre/Kavita passwords, *arr API keys, Civitai/PodcastIndex
keys. Worse, if `SECRETS_KEY` isn't set as an env var the cipher key is auto-persisted into
`app_settings` **in the same SQLite file** (`secrets.ts:24-28`), so DB-file theft yields both
the ciphertext and its key — the host-credential encryption then adds nothing. Nothing forces
or warns the operator to set `SECRETS_KEY`/`PIN_PEPPER`. **Fix: route all tokens through
`encryptSecret` (helper already exists); require/warn on `SECRETS_KEY`; mask secrets in
`GET /api/tools/config/global`, which currently returns Plex+HA tokens in cleartext to the
admin browser (`routes/tools.ts:169-178`).**

**P1-2 — Any household member is handed decrypted VNC/RDP passwords, unaudited.**
`GET /api/remote/display-credentials` (`remote.ts:289-297`) decrypts and returns VNC/RDP
passwords to any user who can "see" a host, and `canAccessHost` treats every shared host as
visible to every authenticated user. The reveal writes **no audit entry**. Also: SFTP
list/download/upload (full remote FS) is never audited, and personal-host session opens
aren't audited (only shared-host opens are). And `admin_audit_log.userId` is
`onDelete: cascade` — deleting a user **erases their access history**. Reachable by: any
member. **Fix: audit every credential reveal / SFTP op / session open; change the audit FK to
`set null` so the trail survives account deletion.**

**P1-3 — Host shell + coding terminal are unrestricted and reachable by non-admins.**
`/api/coding` gives any authenticated non-admin a persistent `claude` PTY
(`coding.ts:30`, sandboxed by OS user, but that is not a feature/authz boundary). The host
shell (`lib/codingServer.ts:253`) is `/bin/bash -l` as the backend user with **no command
allow/deny list** and only the session-open event audited — post-incident you know a shell
opened, not what ran. Combined with P0-2, an exposed instance lets a stranger reach a shell
on your LAN. **Fix: raise `remote`/`coding` to a per-profile capability (default off for
kids); log commands, not just opens; consider running the shell as a lower-privilege user
than the one owning the DB.**

**P1-4 — Bookmark reverse-proxy runs third-party HTML in the app's own origin (stored XSS →
desktop-bridge pivot).** `routes/proxy.ts:89-128` serves rewritten upstream HTML from the
app origin, stripping `x-frame-options` and inline CSP `<meta>` and setting no CSP itself;
`BookmarkReadPage.tsx:224` iframes it with `allow-same-origin allow-scripts`. Script on an
attacker-authored proxied page runs as the app origin → can call `/api/*` with the victim's
cookie. A **global bookmark** (`ownerId=null`) is proxied by every member → household-wide
account takeover. On the **desktop shell** this is worse: the iframe origin *is* the server
origin, so a hostile page can reach `window.parent.lokiDesktop.captureScreen()` /
`fsRequest()` and `getUserMedia()` — silent screenshot, read of user-picked folders, hot
mic. **Fix: serve the proxy from a cookieless sandbox origin (or `CSP: sandbox` without
`allow-same-origin`); don't strip upstream framing/CSP.**

**P1-5 — People/property lookup is a default-on, unaudited doxxing surface.**
`routes/lookup.ts` is `requireAuth` only (any profile, including a child), and the
`people_lookup` / `property_lookup` companion tools are **enabled by default**
(`toolConfig` starts all-on). No consent gate, no rate limit, and the query cache hashes the
input so you **can't even reconstruct who searched whom**. A kid asking the companion "who
lives at <address>" gets names, phones, associates. This is the sharpest product-level
privacy/legal finding. **Fix: default this tool off; require an explicit toggle + audit +
rate limit; exclude from the default companion toolset.**

**P1-6 — Default bind is `0.0.0.0` with no TLS, and the boot log says `localhost`.**
`index.ts` exports the server with no `hostname` (Bun defaults to all interfaces) and prints
`http://localhost:${port}`, which is misleading. Session cookies are `Secure` only over
HTTPS, so an exposed plain-HTTP instance leaks them in cleartext.
**Correction to the original recommendation:** binding to `127.0.0.1` by default is WRONG for
this product — it is inherently a household LAN server (wall displays, Pods, family phones
all connect over the LAN), so loopback-only would break everything but the local box. The
right fix (implemented) is: keep `0.0.0.0` for LAN function but make it configurable via
`HOST` (so a security-conscious operator can pin it, e.g. loopback behind a same-box TLS
proxy), and replace the misleading log with an accurate, exposure-aware one that warns
against port-forwarding without a TLS reverse proxy. Blast-radius reduction for P0-2/P0-3/
P1-4 comes instead from their own fixes (loopback-only admin recovery, LAN-gated pod
endpoints).

### P2 — Medium (correctness/hardening; mostly LAN-contained today)

- **P2-1 — New readable SSRF: `GET /api/videos/link/stream/:id`** (`routes/videos.ts:388` +
  `lib/videos/providers/link.ts:79`) spawns yt-dlp on a user URL and streams stdout back
  without `assertPublicUrl` (the sibling `/save` and `/item` paths are guarded; `/stream`
  skips it). Fix: `assertPublicUrl` in `getPlayback`.
- **P2-2 — Missing `--` terminator cluster** on yt-dlp argv at `lib/videos/download.ts:150,153`
  and `routes/videos.ts:400` (not currently exploitable — provider-built URLs — but the
  defense-in-depth the C2 fix prescribed was not applied consistently).
- **P2-3 — kosync open, unauthenticated account registration** (`routes/kosync.ts:31`)
  stores the client's md5 verbatim and best-effort links to an app user by nickname match —
  pre-register under a member's nickname to surface reading in-app. No session escalation.
- **P2-4 — Consent fails open when no record exists** (`lib/consent.ts:99-144`): an operator
  who never runs the wizard gets risky features with no waiver on file. High-risk features
  (SponsorBlock cutting, download/scrape) have only the generic waiver.
- **P2-5 — Frigate event history and adult-flagged music stations aren't owner/profile
  scoped** (`routes/frigate.ts:143`, `musicStations.ts:348`); kid media filter fails open on
  classifier error (`videos/policy.ts:82`); `blockProfanity`/`blockSensitiveTopics` prompt
  fragments are dead code (`protections.ts:134`, never called).
- **P2-6 — Desktop bridge hardening nits:** `shell.openExternal` has no scheme allow-list
  (`windows.js:37`); `main:open` origin-lock is bypassable with `//evil.com` (`ipc.js:191`);
  `listDir` leaks size/mtime of denylisted symlink targets (`fileAccess.js:85`). The bridge
  is otherwise well-built (contextIsolation, sandbox, narrow contextBridge, realpath file
  boundary) — the real risk is P1-4 pivoting through it.
- **P2-7 — Error `String(err)` still returned to clients** at `narration.ts:53`,
  `recipes.ts:72`, `logo.ts:34` (low-value leakage; sanitize).

### Legal / framing (operator exposure, not a code bug)

- **SponsorBlock ad-cutting is default-ON** (`lib/youtube/sponsorblock.ts:17`), and
  `lib/plex/cut/run.ts` renders a new derivative file with ranges removed and re-hosts it.
  The code/comments describe this as ad-skipping convenience — which **contradicts the
  project's own required framing** (privacy / protecting loved ones, never
  convenience/ad-skipping). Make it opt-in with a feature-specific disclaimer and reframe the
  comments.
- yt-dlp client-spoofing to sidestep YouTube's PO-token challenge, admin cookies for
  age-gated content, and headless-Chromium retail scraping to defeat bot walls are all
  ToS/CFAA/§1201-flavored. Gate behind explicit per-feature acknowledgement, not the generic
  waiver.

---

## Part 3 — What is already strong (don't over-invest here)

Verified sound, so the hardening budget can skip these: argon2id PINs with a pepper,
per-profile lockout **and** a per-IP throttle that correctly distrusts `X-Forwarded-For`
(`lib/pin.ts`, `pinThrottle.ts`); 256-bit session tokens stored only as SHA-256, 7-day
expiry, logout invalidation, no fixation (`lib/session.ts`); thorough `requireAdmin` coverage
on every admin router (no `requireAuth`-only leaks among them); CSRF (SameSite=Strict +
Origin-host); the `assertPublicUrl` SSRF guard re-validating every redirect hop, now wired
through the whole plain-`fetch` class the prior audit flagged (H1 fixed); prior C1 ffmpeg
crash fixed; **zero developer telemetry** anywhere (no Sentry/PostHog/GA/crashReporter);
**LLM inference is local-only** (Ollama, no cloud keys) so chat/memory never leave the box;
companion memory is server-scoped per user; per-profile content clamp is genuinely
server-enforced with an admin-only dial ceiling; the Electron bridge is well-hardened
(contextIsolation/sandbox/narrow contextBridge/realpath file boundary); no DRM circumvention
(archive.org DRM items actively refused); /drop is correctly user-isolated. The hands-free
"mic stays live" bug from the prior audit is fixed.

---

## Part 4 — Recommended sequence

1. **P0 live holes first** — clipper `/save` RCE, `/api/auth/select` admin takeover, unauth
   camera/pod endpoints, child-safety server enforcement. These are exploitable today and a
   feature gate would not fully close them.
2. **P1-6 bind to loopback + document TLS** — one change, shrinks the blast radius of almost
   everything else.
3. **P1-1 secrets** — encrypt the remaining tokens, require `SECRETS_KEY`, mask the config
   endpoint.
4. **Then build the capability gate** as proposed, with the three corrections: enforce at
   route+WS+poller+token+job layers; add a **per-profile capability** dimension (not just a
   household boolean) for `remote`/`coding`/host-shell; unify with the existing
   `consent` + `toolConfig` models rather than a fourth parallel table. Default the
   critical/network features off; PIN-to-enable *and* per-profile authz-to-use; audit every
   blocked attempt and every enable/disable.
5. **P1-2/P1-3 audit + least-privilege** for remote/host-shell/coding (log commands, scope
   per profile, un-cascade the audit trail).
6. **P1-4 sandbox the bookmark proxy origin**; **P1-5 gate people/property lookup**.
7. **Legal/framing pass** — SponsorBlock opt-in + reframe; feature-specific waivers.
8. P2 cleanup + the remaining prior-audit MEDIUMs.
