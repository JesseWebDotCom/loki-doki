# Memory System Roadmap — PR2 & PR3

PR1 (this branch) wired persistent storage and fixed the empty Memory page.
PR2 and PR3 finish the system. Read this entire doc before starting either.

## Context

LokiDoki is a multi-user family appliance (Pi 5). Parents and children each
run on their own profile. PR1 introduced a hardcoded `default` user (id=1)
as a bridge — every site is marked `# TODO(auth-PR2)`. PR2 removes that
bridge.

Architectural decisions already locked in (do not relitigate):

- **Auth**: username + 4–8 digit PIN for everyone. Admin users *additionally*
  require a password. Admin-only routes also require a fresh password
  challenge within the last 15 minutes.
- **JWT lib**: `pyjwt`. HttpOnly cookie, 12h expiry.
- **PIN hashing**: `passlib[bcrypt]`. Rate limit: 5 attempts/min/user, in-process.
- **Bootstrap**: when `users` is empty, every API request except
  `/api/v1/auth/bootstrap` and the wizard's static assets returns
  `409 {"error": "needs_bootstrap"}`. Implemented as FastAPI middleware
  with an allowlist, NOT per-route.
- **Admin freshness**: store `last_password_auth_at` on the user row, checked
  by `require_admin` dependency. 15-minute window.
- **First user auto-promoted to admin**.
- **User deletion is soft**: `status='deleted'`, row preserved for FK integrity.
- **Embeddings**: 384 dim (`all-MiniLM-L6-v2` shape). PR1 stubs zero vectors;
  real embedder lands when convenient. `vec_facts` table already exists.
- **Decomposer JSON repair**: 2B model is unreliable for structured output.
  Use a Pydantic-validated repair/retry loop, NOT strict-or-drop. Strict
  parsing silently loses facts and we'll think extraction is broken.
- **Onyx Material design**: shadcn/ui primitives, Elevation 1–4, Material
  purple accents (~`#A78BFA`) on onyx surfaces (`#0A0A0A` / `#171717`). Match
  existing components if tokens are already defined; otherwise define them
  in `frontend/src/index.css` + a `theme.ts` once.
- **File size**: 250-line cap per CLAUDE.md. Split aggressively.
- **TDD**: tests first, watch fail, implement, watch pass. Mandatory.

## PR2 — Auth, Users, Admin

### Schema additions

The `users` table already exists from PR1 with: `id, username, pin_hash,
password_hash NULLABLE, role, status, created_at`. Add:

- `last_password_auth_at INTEGER NULLABLE` (unix seconds)
- Index on `username` (unique already)

### Backend

#### Dependencies
- `uv add pyjwt passlib[bcrypt]`

#### New files (suggested split, all < 250 lines)
- `lokidoki/auth/passwords.py` — PIN/password hash + verify, with rate limiter
- `lokidoki/auth/tokens.py` — JWT sign/verify, cookie helpers
- `lokidoki/auth/dependencies.py` — `current_user`, `require_admin`
- `lokidoki/auth/users.py` — user CRUD on top of `MemoryProvider`
- `lokidoki/api/routes/auth.py` — `/auth/bootstrap`, `/login`, `/logout`, `/me`, `/challenge-admin`
- `lokidoki/api/routes/admin.py` — admin user mgmt
- `lokidoki/api/middleware/bootstrap_gate.py` — 409 middleware

#### Routes
- `POST /api/v1/auth/bootstrap` — `{username, pin, password}` → first admin. 409 if any user already exists.
- `POST /api/v1/auth/login` — `{username, pin}` → sets cookie. 401 on miss/disabled/deleted.
- `POST /api/v1/auth/logout` — clears cookie.
- `GET  /api/v1/auth/me` — current user (or 401, or 409 if needs_bootstrap).
- `POST /api/v1/auth/challenge-admin` — `{password}` → bumps `last_password_auth_at`.
- `GET  /api/v1/admin/users` — list (admin)
- `POST /api/v1/admin/users` — create new user `{username, pin, role}` (admin)
- `POST /api/v1/admin/users/{id}/disable|enable|delete` (admin)
- `POST /api/v1/admin/users/{id}/promote|demote` (admin)
- `POST /api/v1/admin/users/{id}/reset-pin` `{new_pin}` (admin)

All admin routes guarded by `require_admin` (which enforces freshness window).

#### Rewire PR1 TODOs
- `lokidoki/core/memory_provider.py` — drop `_ensure_default_user` and `DEFAULT_USERNAME`. Provider methods stop having an implicit default.
- `lokidoki/api/routes/chat.py` — replace `default_user_id` calls with `current_user.id` from the dependency. Sessions become user-owned for real.
- `lokidoki/api/routes/memory.py` — same.
- Re-introduce per-user sentiment store (`TODO(sentiment-PR2)` in `chat.py /memory`). Either a `user_sentiment` table or aggregate from messages on read.
- Wire `clearChatMemory` and `deleteSession` real route handlers (PR1 left them as client-side no-ops). Both must be user-scoped.

### Frontend

#### Dependencies
- Already has React 19, react-router 7, shadcn/ui. No new deps needed unless you add a form library — `react-hook-form` + `zod` recommended for the wizard/login forms (not strictly required).

#### New files
- `frontend/src/auth/AuthProvider.tsx` — context with `currentUser`, `login`, `logout`, `bootstrap`, `challengeAdmin`. Calls `/auth/me` on mount. On 409, sets `needsBootstrap`.
- `frontend/src/auth/useAuth.ts`
- `frontend/src/components/BootstrapGate.tsx` — wraps router, force-routes to `/wizard` if `needsBootstrap`, to `/login` if 401.
- `frontend/src/pages/WizardPage.tsx` — Onyx Material form, fields: username / PIN / confirm PIN / password / confirm password. POSTs `/auth/bootstrap`, then redirects to `/login`.
- `frontend/src/pages/LoginPage.tsx` — username + PIN. On success → `/chat`.
- `frontend/src/pages/AdminPage.tsx` — user table, role badge, status badge, action buttons. If `challengeAdmin` returns expired, show a password modal then retry.
- `frontend/src/components/AdminPasswordPrompt.tsx` — reusable modal.

#### Routing
Update `frontend/src/App.tsx` (or wherever router is defined): wrap routes in `<AuthProvider><BootstrapGate>...</BootstrapGate></AuthProvider>`. Add `/wizard`, `/login`, `/admin`. `/admin` guarded — redirect non-admins.

#### Tests (vitest)
- `AuthProvider` happy path: `/auth/me` 200 → currentUser populated
- `AuthProvider` 409 → `needsBootstrap` true
- `AuthProvider` 401 → `currentUser` null
- `WizardPage` form validation (PIN length, PIN match, password length)
- `BootstrapGate` redirect logic (mock react-router)

### Backend tests (pytest)

- Bootstrap creates first admin; subsequent bootstrap returns 409
- Login: success, wrong PIN, disabled user, deleted user, rate limit kicks in after 5 fails
- `current_user` dependency: cookie missing → 401; valid → user; disabled → 403
- `require_admin`: non-admin → 403; admin without recent password auth → 403; admin with fresh auth → ok
- Admin user mgmt: list, create, disable/enable/delete, promote/demote, reset-pin
- Provider isolation: user A cannot read user B's facts/messages/sessions through any route
- Bootstrap gate middleware: when no users, all routes except allowlist return 409

### Exit criteria

- `pytest` green
- `npm --prefix frontend run test` green (PR1 SSE test still passes + new auth tests)
- `npm --prefix frontend run build` green
- All `# TODO(auth-PR2)` markers removed
- Default user seeding deleted from `memory_provider.py`
- A fresh `data/lokidoki.db` triggers the bootstrap wizard on first load

---

## PR3 — People, Relationships, Hybrid Search, Memory UI

### Decomposer rewrite

- File: `lokidoki/core/decomposer.py`
- Update prompt so `long_term_memory` items are structured:
  ```json
  {
    "subject": "self" | {"person": "<name>"},
    "predicate": "occupation",
    "value": "electrician",
    "kind": "fact" | "relationship",
    "relationship_kind": "brother" | "spouse" | ... | null
  }
  ```
- **Pydantic-validated repair loop**: parse model output → if validation fails, send a follow-up prompt with the validation errors and ask the model to repair → max 2 retries → on final failure, log + drop that item only (never the whole turn).
- New module `lokidoki/core/decomposer_repair.py` for the repair loop.
- Test fixtures: `tests/fixtures/decomposer/` with at least:
  - `self_fact.txt` → "I work as an electrician"
  - `person_fact.txt` → "my brother lives in Denver"
  - `relationship.txt` → "my daughter is named Mira"
  - `multi.txt` → mixed example with 3+ items
  - `malformed.txt` → known-bad JSON to exercise the repair loop

### Orchestrator changes

- When decomposer emits a `subject={"person": name}` item:
  - Find-or-create `people` row by `(owner_user_id, lower(display_name))`
  - Write fact with `subject_type='person'`, `subject_id=<person.id>`
- When `kind='relationship'`:
  - Also write a `relationships` row (`from`=user, `to`=person, `kind=relationship_kind`)
  - Confidence on the relationship row uses the same `update_confidence` function
- Drop the `TODO(people-PR2)` hardcoded `subject="self"` in `orchestrator.py`

### Hybrid search

- File: `lokidoki/core/memory_provider.py` (or split into `memory_search.py` if it grows)
- `search_facts(user_id, query, k=20)`:
  1. Run FTS5 BM25 against `facts_fts`, scoped by `owner_user_id`
  2. If `vec_facts` has any non-zero vectors for this user, also run cosine via `vec0`
  3. Blend: `score = 0.5 * bm25_norm + 0.5 * cosine_norm` (normalize each to [0,1] via min-max within the result set)
  4. If embeddings are all zero (PR3 may still ship without a real embedder), skip step 2 and return BM25 only
- Reference the old loki-doki implementation: `/Users/jessetorres/Projects/loki-doki/app/subsystems/memory/store.py:200` for the SQL pattern. Don't copy verbatim.

### Real embedder (optional in PR3, can defer)

- Wire `sentence-transformers` or `fastembed` for `all-MiniLM-L6-v2` (384 dim).
- Background job or sync-on-write — sync-on-write is simpler, do that.
- Mark with `# TODO(embeddings-perf)` if sync-on-write becomes a bottleneck.

### New routes

- `GET /api/v1/memory/people` — list people for current user
- `GET /api/v1/memory/people/{id}` — person detail with facts about them
- `POST /api/v1/memory/people/{id}/merge` `{into_id}` — merges duplicate people (rewrites facts/relationships, deletes the merged row). Admin or owner only.
- `GET /api/v1/memory/relationships`
- `GET /api/v1/memory/facts/conflicts` — facts where same `(subject, predicate)` has multiple distinct values; needed for conflict UI

### Frontend — Memory page

Replace current Memory page with a tabbed layout (shadcn `Tabs`):

- **People tab**: card grid of people with avatar (initials), name, fact count, relationship to user. Click → person detail drawer.
- **Relationships tab**: simple list grouped by `kind` (Family, Friends, Other). Each row shows confidence bar. Could grow into a graph viz later — out of scope for PR3.
- **Facts tab**: grouped by subject (Self first, then each person alphabetically). Each fact row: predicate, value, confidence bar (shadcn `Progress` with Material purple), confirmation count. Search box hits `/facts/search`.
- **Conflicts callout** at top of Facts tab if `/facts/conflicts` returns any. Show conflicting values side-by-side with a "which is correct?" affordance — clicking a value increments its confirmations and demotes the others. (Demotion = no-op storage-wise; UI just sorts by confidence.)

### Tests

Backend:
- Decomposer fixture extraction (5 fixtures above)
- Repair loop: malformed JSON triggers repair, eventually drops cleanly
- Find-or-create person is idempotent + case-insensitive
- Person merge moves all facts/relationships and deletes source
- Hybrid search returns BM25-only when vectors are zero, blended when non-zero
- `/facts/conflicts` returns multi-value rows correctly

Frontend (vitest):
- Memory page renders people/relationships/facts from mocked API
- Conflict callout appears when conflicts present
- Confidence bar width correlates with confidence value
- Search input debounces and hits the right endpoint

### Exit criteria

- `pytest` green
- vitest green
- TS build green
- All `# TODO(people-PR2)` and `# TODO(embeddings)` markers either resolved or downgraded to `# TODO(embeddings-perf)` if real embedder is deferred
- A fresh chat session that says "my brother Mark lives in Denver and works as a plumber" produces, after sync, exactly one `people` row (Mark), one `relationships` row (user→Mark, kind=brother), and two `facts` rows on subject=Mark (location=Denver, occupation=plumber), each at base confidence

---

## Things to NOT do

- Don't add features beyond this doc. No graph visualizations, no fact editing UI, no import/export, no multi-device sync, no encryption-at-rest.
- Don't refactor PR1 code that isn't blocking PR2/PR3.
- Don't introduce a new state management library. React context is sufficient.
- Don't switch SQLite drivers. PR1's `sqlite3 + asyncio.to_thread + Lock` choice is intentional (sqlite-vec needs `enable_load_extension`).
- Don't delete the `default user` seeding until PR2's bootstrap flow is fully working end-to-end with tests passing.

## Greppable PR1 markers to clear

```
TODO(auth-PR2)        — PR2
TODO(sentiment-PR2)   — PR2
TODO(people-PR2)      — PR3 (misnamed, but that's fine; grep for it)
TODO(embeddings)      — PR3 (or deferred to TODO(embeddings-perf))
```
