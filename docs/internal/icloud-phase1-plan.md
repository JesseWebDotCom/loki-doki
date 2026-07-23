# iCloud Phase 1 — Implementation Plan (2026-07)

Status: SHIPPED on main 2026-07-23 — M1 82fc9ff, M2 3a9373a, M3 ccd1238,
M4 833147d, M5 3bfc18b. Deviations from plan noted inline below; the notable one:
no briefing mail source (the briefing cache is shared per location and would leak
per-member mail across profiles) — mail surfaces are the opt-in ticker section,
the per-viewer companion line, and the Admin triage panel instead. postal-mime was
not needed (snippets come from bounded MIME-part downloads via imapflow).
Scope source: `icloud-integration-research.md` (Part 1/1b/1c). Phase 1 = Apple
account connection (ASP) + read-only CalDAV calendar + calendar surfaces/companion/
briefing + Mail MVP (ingestion + dry-run triage, no destructive actions).
All hook points below were verified against the code before writing.

## Ground rules

- Everything behind two new feature gates in `backend/src/lib/featureGate.ts`:
  `icloud-calendar` (risk medium, defaultEnabled false) and `icloud-mail`
  (risk high, defaultEnabled false, **perProfile**). Incomplete work on main is inert.
- **Repo rule**: `runMigrations()` in `backend/src/db/index.ts` is the authoritative
  schema source — every new table appears both in `db/schema.ts` (drizzle) and as an
  idempotent `CREATE TABLE IF NOT EXISTS` there (migrations journal frozen at 0016).
- Credentials via `secrets.ts` `encryptSecret`/`decryptSecret` (keystore-backed);
  ASP plaintext is never returned by any API.
- All LLM work local (existing model roles in `lib/models.ts`), cascade-first,
  uncertain-band-only, and only under `shouldRunOpportunistic()` — honors the
  8GB LLM-first GPU. No new model downloads.

## Library choices (new deps, isolated behind thin wrappers)

- **CalDAV: `tsdav`** — pure TS, RFC 6764 discovery, sync-token collection sync.
  Wrapped in `lib/icloud/caldav.ts` so a hand-rolled PROPFIND/REPORT (~300 lines)
  is a drop-in replacement if tsdav misbehaves on Bun.
- **ICS: `ical.js`** — its RecurExpansion handles RRULE + EXDATE + RECURRENCE-ID;
  no need for `rrule`/`node-ical`.
- **IMAP: `imapflow`** (nodemailer ecosystem — we already ship nodemailer). IDLE
  support; the long-lived `node:tls` socket is the main Bun risk → periodic sweep
  fallback is the safety net.
- **Bodies on demand: `postal-mime`** (no Node streams; `mailparser` as fallback).
  Ingestion itself uses imapflow FETCH envelope/headers/snippet — no parser needed.
- Reused: `zod` (verdict schemas), `chrono-node` (tool date parsing).

## DB schema (schema.ts + mirrored CREATEs)

- `icloud_accounts` — userId FK, appleId, passwordEnc, caldavHomeUrl,
  caldavStatus/imapStatus (`ok|auth_error|error|unprobed`), lastProbeAt, lastError.
  Unique(userId, appleId).
- `icloud_calendars` — accountId FK, url, name, colorHex, enabled, ctag, syncToken,
  lastSyncAt. Unique(accountId, url).
- `icloud_events` — master VEVENTs: calendarId FK, uid, href, etag, summary,
  location, allDay, startsAt/endsAt (epoch ms), rrule flag, rawIcs (kept for
  re-expansion), status. Unique(calendarId, href).
- `icloud_event_occurrences` — windowed instances (−7d..+60d), rebuilt idempotently
  per sync; denormalized userId for fast household queries. Index (startsAt),
  (userId, startsAt).
- `icloud_mail_folders` — accountId, folder, uidValidity, lastSeenUid, lastSweepAt.
- `icloud_mail_messages` — headers-level index only (from, subject, ~200-char
  snippet, receivedAt, flags, listUnsubscribe, raw Authentication-Results,
  hasAttachments). **No bodies stored.** Unique(accountId, folder, uid).
- `icloud_sender_stats` — senderAddress, seenCount, repliedCount (backfilled from
  "Sent Messages"), first/lastSeenAt. Feeds the triage heuristics.
- `icloud_mail_verdicts` — append-only: messageId, bucket (`ignore|notify|respond`),
  method (`heuristic|llm|rule`), confidence, human-readable reason, model,
  createdAt. Latest row per message = cache; whole table = audit log.

## Milestones (each independently shippable, one commit each, gates off by default)

### M1 — Apple account connection + gates + status (~700 LOC, 1–2 days)
- New `lib/icloud/accounts.ts` (CRUD, probe: CalDAV PROPFIND via well-known + IMAP
  LOGIN `imap.mail.me.com:993`; 401 → `auth_error`) and `routes/icloud.ts`
  (admin endpoints; ASP format hint `xxxx-xxxx-xxxx-xxxx`).
- Modify `featureGate.ts`, `routes/integrationsStatus.ts` (an `apple-icloud` row;
  any `auth_error` → state error, detail "Reconnect needed for <member>"),
  schema + `db/index.ts`.
- New `frontend/src/components/admin/AdminICloudSection.tsx` (per-member connect
  cards, probe results, reconnect CTA); register in `adminRegistry.ts` +
  `integrationsRegistry.ts`.

### M2 — CalDAV sync engine (~1000 LOC, 2–3 days)
- New `lib/icloud/caldav.ts`, `ics.ts` (parse + windowed expansion, household
  timezone, VTIMEZONE), `calendarStore.ts` (transactional upsert + occurrence
  rebuild), `calendarPoller.ts` (`startICloudCalendarPoller`, ~5 min, gated,
  backs off + flips auth_error on 401s, notifies once on first auth failure).
- Wire poller in `backend/src/index.ts` (dynamic import pattern). Routes: list
  calendars, per-calendar enable toggle, sync-now. Admin: calendar list per member.

### M3 — Calendar surfaces + companion + briefing (~1100 LOC, 3–4 days)
- `GET /api/icloud/calendar/events?from&to` (requireFeature, merged household view,
  per-member color accents).
- HUD: extend `hud/useTodayItems.ts` + `IslandPageCalendar.tsx` (event dots on month
  grid, timed items in Today column). Home: de-boxed today/week timeline section —
  typographic, flat, per-member accent bars; follow the ticker's flat treatment,
  never a boxed widget tile (home-ui-premium-feel rule).
- Companion: new `lib/icloud/calendarBlock.ts` — compact next-7-days block, cached
  like briefing (refreshed at end of each poller sync, synchronous read), pushed
  into `companionTurn.ts` systemParts after the briefing block (~line 957).
- New `backend/src/tools/calendar.ts` (weather.ts pattern: examples,
  `passMessage: 'query'`, chrono-node dates, queries occurrences, `offline: true`);
  register in `tools/index.ts`.
- Briefing: `calendar` source in `lib/briefing/types.ts` + refresh task + render
  section.

### M4 — Mail ingestion (~900 LOC, 2–3 days)
- New `lib/icloud/mail/imapClient.ts` (folder quirks: "Sent Messages"/"Deleted
  Messages"), `watcher.ts` (IDLE on INBOX + 10-min sweep fallback, uidValidity
  handling, reconnect/backoff, auth_error flip), `ingest.ts` (headers + snippet +
  Authentication-Results → `icloud_mail_messages`; sender stats; one-time Sent scan
  to backfill repliedCount).
- Wire watcher in `index.ts` (gated). Routes: mailbox status + recent index —
  authorization is owner-or-admin AND `userMayUseCapability('icloud-mail')`.

### M5 — Triage cascade + surfaces + admin tuning (~1100 LOC, 3–4 days)
- New `lib/icloud/mail/heuristics.ts` (sender seen/replied, List-Id/List-Unsubscribe,
  SPF/DKIM from stored authResults, VIP list), `triage.ts` (cascade: heuristics
  decide confidently; uncertain band queued, drained only under
  `shouldRunOpportunistic()`; fresh arrivals get heuristics immediately),
  `llmJudge.ts` (Ollama structured JSON via existing model roles, zod-validated,
  cached per messageId, appended to verdicts table).
- **No folder moves/deletes anywhere in Phase 1** — verdicts are dry-run data.
- Surfaces (per Jesse's visibility decision, 2026-07-23 — **mail is private per
  member; admins additionally see kids' notify-bucket flags only, never the full
  mail index; no mail in the always-shared ticker rotation**):
  `mail` ticker source exists but renders only in per-profile contexts — the
  active profile's own notify items, plus their kids' notify items when the
  active profile is a parent/admin (subjects only, never bodies/snippets of kid
  mail). Per-user mail line in the companion block (same visibility rule) so
  "anything important?" grounds naturally; `mail` briefing source is per-user
  (own items + kids' flags for admins). AI verdicts carry `AiGeneratedBadge`.
  Route authorization mirrors this: notify-bucket endpoint allows owner or
  parent/admin; the full message-index endpoint is owner-only.
- Admin: verdict audit table, bucket counts, method split (heuristic vs llm —
  watch that >70% resolve on heuristics), VIP/rules tuning.

## Verification

Per milestone: `bun run check:build`, `npx vite build`,
`bun run check:design-contract`. Runtime via the `/verify` skill (headless app
against isolated backend) for the Admin connect flow, HUD island, and Home section
using the seeded demo household — CalDAV/IMAP base URLs are env-overridable so a
local fixture server can stand in for Apple (also enables credential-free tests).
Before each milestone lands: one real Apple ID + ASP smoke test on the dev Mac.

## Risks / open questions

1. tsdav + imapflow on Bun (IDLE socket riskiest) → wrappers, sweep fallback,
   fixture-server overrides; hand-rolled CalDAV as plan B.
2. ASP revocation → 2 consecutive 401s flip auth_error, one notify, reconnect CTA;
   synced data never deleted.
3. Sync-token invalidation → clear token, full resync (idempotent upserts).
4. Recurrence/timezones → UTC epochs + allDay flag, expand in household TZ, rawIcs
   retained.
5. Mail privacy → strictly per-member rows; perProfile gate default-denies.
   Visibility decided by Jesse 2026-07-23: private per member; parents/admins see
   kids' notify-bucket flags only (not the full inbox); no mail on the shared
   ticker rotation.
