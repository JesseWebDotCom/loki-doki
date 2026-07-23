# iCloud Integration — Research + Feature Brainstorm (2026-07)

Status: research + brainstorm only, nothing approved or built.
Research: deep-research sweep 2026-07-23 (104 agents, adversarially verified; all claims below survived 3-vote verification unless marked).

## Part 1 — How people authenticate with and talk to iCloud (verified, mid-2026)

There are two very different roads in, and the right architecture uses both.

### Road A: CalDAV/CardDAV + app-specific password (rock solid, decade-stable)

- iCloud Calendar and Contacts speak standard CalDAV/CardDAV at `caldav.icloud.com` /
  `contacts.icloud.com` (RFC 6764 well-known discovery works; per-account partition
  hosts like `p11-caldav.icloud.com` are discoverable via a temporary "Public calendar"
  share if a client's autodiscovery is weak).
- Auth is iCloud email + an **app-specific password** (ASP) — the main password never
  works on these endpoints. This has been stable since 2017. Sources: tasks.org,
  DAVx5 docs, Apple support 102654.
- ASP lifecycle gotchas we must design for:
  - ASPs require 2FA enabled on the Apple Account (which every family account has).
  - **Changing/resetting the main Apple password revokes ALL ASPs** — the integration
    must detect 401s and surface a friendly "reconnect Apple account" flow.
- **ADP (Advanced Data Protection) does NOT affect this road** — Calendar/Contacts are
  excluded from end-to-end encryption. This is the reliable backbone.

### Road B: reverse-engineered iCloud web API (fragile, but the only way to Find My)

- Family device location still works in mid-2026 via the private iCloud Location
  Services API. Best evidence: **iCloud3** (Home Assistant custom integration,
  v3.6 June 2026, actively maintained) tracks all Family Sharing devices this way.
- Auth reality since Oct 2024: Apple enforces **SRP-6a login with the MAIN Apple
  password + interactive MFA** (trusted-device push code), then a long-term
  `trust_session()` token. App-specific passwords no longer work for this API.
  The canonical flow is pyicloud's `validate_2fa_code()` → `trust_session()`;
  the maintained fork is **timlaing/pyicloud** (v2.6.5, June 2026) — depend on it
  (or port its flow) rather than any distro-pinned version. Trust-token lifetime is
  NOT reliably established (claims of ~2mo and ~1yr were both refuted in verification)
  — treat re-auth as "occasionally, unpredictably needed."
- Breakage cadence: roughly 2–3 breaks/year, patched within weeks (Nov 2025 pyicloud
  regression; spring 2026 Apple auth change that stopped 2FA push codes, fixed in
  timlaing 2.6.x). Architect for a patch-chasing dependency: isolate it, degrade
  gracefully, never let it take down the rest of the integration.
- The GSA-SRP protocol itself (PBKDF2 + SRP-6a against `/signin/init` +
  `/signin/complete`) is documented and portable to TypeScript (reference:
  musaspacecadet/icloud-auth + timlaing's implementation), so a native Bun port is
  feasible — but running timlaing/pyicloud as a small sidecar is the lower-risk start.
- **ADP is a hard blocker for Road B**: icloudpd documents that ADP disables all web
  access (even the "Access iCloud Data on the Web" toggle doesn't restore it).
  Family accounts must keep ADP off for location features. Detect and surface this.

### Reminders: both roads are dead — the bridge is a Mac node

- Reminders over CalDAV died with iOS 13 (2019): upgraded reminders live in a private
  silo no CalDAV client can reach (DAVx5, BusyMac, Tasks.org all confirm; nothing
  changed as of mid-2026). CalDAV VTODOs still sync between third-party clients but
  are invisible to the real Reminders app — useless for us.
- The proven bridge (what BusyCal ships commercially): an **on-Mac EventKit relay**
  reading/writing the local Reminders database. For us: a tiny agent on an always-on
  Mac (the dev Mac already runs voice/eval stack) that exposes Reminders read/write
  to the Bun backend over the LAN. Known EventKit limit: no sub-tasks/checklists.
  Same relay trivially gives EventKit Calendar access as a bonus/fallback.

### Other routes considered

- **Public .ics share URLs** (webcal): zero-auth read-only calendar feed; good as a
  "minimum viable" per-member calendar source but read-only, polling, no per-event
  detail beyond VEVENT basics. (Not adversarially verified; well-known mechanism.)
- **Shortcuts-on-device relay / Pushcut**: usable escape hatch for actions the web
  API can't do (send iMessage, trigger HomeKit scenes) but requires an always-on
  Apple device per automation and is brittle to maintain. Keep as a later option.
- **CloudKit Web Services / Sign in with Apple / WeatherKit**: developer-account APIs
  for *your own* app containers — they cannot read a user's personal iCloud Calendar/
  Reminders/Find My. Not useful here (we already have Open-Meteo for weather).

### Architecture this implies

1. **Per-family-member "Apple account" connection** in Admin → Integrations with two
   tiers: Tier 1 (ASP → CalDAV/CardDAV: calendar + contacts) and optional Tier 2
   (main password + MFA → sessions via timlaing/pyicloud sidecar: Find My).
   Secrets via `secrets.ts`/keystore. Trust-session blobs persisted and reused.
2. Tier 2 is opt-in with an honest consent screen: main password stored (encrypted
   locally — this is the self-hosted privacy pitch), ADP must be off, may need
   occasional re-verification, may break for weeks when Apple changes things.
3. Sync via the existing poller/job pattern; CalDAV supports sync-token collection
   sync so polling every few minutes is cheap.
4. **Location polling is battery-hostile — minimal polling is a hard requirement**
   (Jesse's constraint, 2026-07). Each iCloud Location Services query forces the
   remote device to wake and take a fresh GPS fix; the old HA iCloud integration
   was notorious for draining family phones this way. Design rules:
   - **Passive-first**: prefer signals that cost the phone nothing — HA companion
     app sensors, WiFi/router presence, existing HA device trackers/zones. Use
     iCloud Find My only when passive sources can't answer.
   - **On-demand only by default**: no background location polling out of the box.
     An iCloud fix is taken only when something actually needs it — an explicit
     "where is Isabella?" question, or an armed, time-boxed watch (e.g. the
     calendar×location nudge arms a watch 30 min before the game, then disarms).
   - **Adaptive intervals** (the iCloud3 playbook) apply only inside an armed
     watch or if the user explicitly opts a device into continuous tracking:
     long intervals parked in a known zone, shorter only around expected
     transitions or after a zone exit.
   - **Per-device budget**: cap iCloud fixes per device per day; surface the count
     in Admin so drain is observable. Never poll devices marked as low-battery.

## Part 1b — The rest of the iCloud surface (follow-up sweep, 2026-07-23)

Verified by a second research pass (3 parallel agents, cited). Short version: Mail is
as solid as CalDAV; Notes/Photos/Drive ride the same fragile web API as Find My or a
Mac relay; iMessage/Health/AirTags are Mac-relay-or-nothing.

### iCloud Mail — second rock-solid pillar (Road A)

- Standard IMAP (`imap.mail.me.com:993`) + SMTP (`smtp.mail.me.com:587` STARTTLS),
  authenticated with the same **app-specific password** mechanism as CalDAV. No OAuth
  (XOAUTH2 rejected); ASP is the only third-party mechanism, and it's sufficient —
  no interactive 2FA at protocol level. **ADP does not affect Mail** (excluded from
  e2e, like Calendar/Contacts). Sources: Apple 102525/102654/102651.
- IMAP IDLE works server-side → a Bun client holding a connection gets near-real-time
  new-mail events. Apple's true push (`XAPPLEPUSHSERVICE`/APNS) is Apple-only.
- Quirks: nonstandard folder names (`Sent Messages`, `Deleted Messages`); send limits
  1,000 msgs/day, 500 rcpt/msg, 20 MB cap; Hide My Email addresses can't be a
  third-party From (relay-only).

### Apple Notes — no sanctioned server route; two workable paths

- The legacy IMAP `Notes` folder is dead for modern accounts (notes moved to CloudKit
  in 2015; they "don't support IMAP").
- **timlaing/pyicloud exposes a Notes service** (v2.6.5, June 2026) — same Tier 2
  main-password+MFA auth, same fragility. So if the Find My sidecar exists anyway,
  Notes read comes almost free.
- **Mac relay is the reliable read/write path**: Notes.app AppleScript/JXA gives
  list/read (HTML body)/create/update/delete; proven by multiple maintained MCP
  servers (karlhepler/apple-mcp etc.). Losses: attachments dropped, checklist state
  degrades. High-fidelity read-only alternative: parse the local Notes SQLite store
  (Obsidian Importer approach — preserves tables/images/scans).

### iCloud Photos — icloudpd (Tier 2) + a zero-auth gem

- **icloudpd** actively maintained (v1.32.3, May 2026), Docker-friendly, incremental
  sync + watch mode, supports iOS 16 Shared Library. Auth is Tier 2 (main password +
  MFA; ASPs explicitly don't work; docs cite **~2-month trust-token expiry** → the
  classic periodic re-auth pain). ADP breaks it. 1–2 auth breaks/year, fixed quickly.
- **Public Shared Albums need NO auth**: the `sharedstreams…/webstream` endpoint still
  works for link-shared albums (must follow the HTTP 330 partition redirect), is
  outside ADP's e2e scope, and has a tiny TypeScript npm wrapper
  (`icloud-shared-album`) that fits Bun directly. Unofficial but long-lived (e-ink
  frame community relies on it). Cheapest possible photo win.
- Mac-relay alternative: **osxphotos** (healthy, macOS 27-ready) reads the local
  Photos.sqlite library with albums/faces/keywords — full-fidelity, ADP-immune.

### iCloud Drive — web API or Mac folder

- No official API, no WebDAV. timlaing/pyicloud has a full drive module
  (list/upload/download/rename/trash); rclone's `iclouddrive` backend is the same
  idea (SRP + 2FA, 30-day trust, no ASPs). All Tier 2 fragility + ADP caveats apply.
- Mac relay is most robust: Drive is just `~/Library/Mobile Documents/com~apple~CloudDocs`;
  gotcha is "Optimize Mac Storage" evicting files to `.icloud` placeholders —
  force-materialize with `brctl download` (still the tool on current macOS) or
  disable optimize on the relay Mac. ADP-immune.

### iMessage — Mac relay only, BlueBubbles is the standard

- Every living bridge (BlueBubbles, AirMessage, Beeper's 2025 relaunch) requires an
  always-on Mac signed into the Apple ID; Apple's crackdowns hit protocol spoofing
  (Beeper Mini), not genuine Mac relays.
- **BlueBubbles server**: reads `~/Library/Messages/chat.db` (needs Full Disk Access),
  sends via AppleScript (SIP stays on); tapbacks/typing/edits need its Private API
  helper (SIP off — probably not worth it for us). Exposes REST + webhooks, ideal
  substrate for a Bun integration. Known wart: Messages.app idles and stops writing
  chat.db (issue #750) — needs keep-alive on the relay Mac.

### The long tail

- **Apple Health**: best route is the **Health Auto Export** iOS app — scheduled JSON
  POST of 150+ metrics to any REST endpoint (our Bun backend), actively maintained.
- **AirTags / Find My items**: classic OpenHaystack key-extraction is dead
  (Sequoia locked the keychain item); the working 2026 pattern is reading the local
  Find My cache on a Mac (**FindMySyncPlus**, v1.4.1b May 2026 — Full Disk Access +
  one-time SIP-off key extraction, then REST/MQTT out).
- **Screen Time**: confirmed no programmatic export exists. Skip.

### Apple account commerce: subscriptions, prices, renewals (Jesse's ask, 2026-07)

- **No API for a user's own App Store purchases/subscriptions exists.** Apple's App
  Store Server API is developer-scoped (your own app's transactions only). The full
  list lives only behind the browser session at reportaproblem.apple.com — state of
  the art for export is a userscript CSV button on the logged-in page; no maintained
  headless scraper. Don't build on this.
- **What IS reachable via the pyicloud sidecar** (verified in timlaing source):
  iCloud+/storage **plan summary + pricing** (commerce-gateway endpoints), storage
  usage breakdown, and the **Family Sharing roster** (per-member appleId, age
  classification, parental privileges, `hasAskToBuyEnabled`, screen-time/share-
  purchases flags).
- **Email is the only passive feed for the rest**: `no_reply@email.apple.com`
  receipts and renewal/price-increase notices reliably contain item, plan, price,
  and renewal/billing date; **Ask to Buy requests also arrive as parent emails**
  (no API to list/approve them). No off-the-shelf Apple-receipt-email parser exists
  (existing "receipt parsers" do ASN.1 in-app receipts) — this would be custom IMAP
  + HTML parsing, which our Road A Mail lane already sets up. Self-hosted trackers
  (Wallos etc.) are manual-entry; we'd leapfrog them.
- Feature shape: a **household subscriptions ledger** — LLM-parsed Apple receipt/
  renewal emails (works for Netflix/Spotify/etc. billed through Apple, and the same
  parser generalizes to non-Apple subscription emails) → renewal-date calendar
  entries, "price went up" ticker alerts, monthly spend rollup in briefing; Ask to
  Buy emails → instant "Milo wants to buy Minecraft coins" nudge on HUD/companion
  (approval still happens on the parent's Apple device); iCloud storage plan +
  usage in Admin ("family is at 92% of the 200GB plan").

### Revised mental model: three buckets

1. **Road A (ASP, stable, ADP-proof)**: CalDAV Calendar + CardDAV Contacts +
   **IMAP/SMTP Mail** — build with confidence.
2. **Road B (Tier 2 web API, fragile, ADP-blocked)**: Find My, Photos (icloudpd),
   Drive, Notes-read — one shared pyicloud-sidecar auth investment powers all four;
   all inherit the same break-and-patch cadence. Plus zero-auth Shared Albums, which
   need nothing at all.
3. **Road C (Mac relay on the always-on Mac node)**: Reminders (EventKit), iMessage
   (BlueBubbles/chat.db), Notes read-write (AppleScript), full-fidelity Photos
   (osxphotos), Drive-as-folder, AirTags (Find My cache). One Mac agent, many
   services, ADP-immune — the strategic asset. The dev-Mac voice stack precedent
   means a LAN relay daemon pattern already fits the household.

## Part 1c — AI × Mail: what the ecosystem does (GitHub sweep, 2026-07-23)

Three-agent sweep of how open-source projects do AI mail triage, junk weeding,
domain filtering, unsubscribing, and structured extraction. Net: the two biggest
AI-mail projects can't talk to iCloud, but every mechanic we need is proven
somewhere over plain IMAP — we'd be assembling known patterns, not inventing.

### Landscape

- **Gmail/Outlook-API only (can't touch iCloud, steal mechanics not code):**
  **inbox-zero** (elie222, ~11.7k★, AGPL, very active) — plain-English AI rules,
  cold-email blocker, Reply Zero, bulk unsubscribe, digests; supports Ollama.
  **Mail-0/Zero** (~10.7k★) similar, slowing. **EAIA** (langchain) — reference
  agentic triage architecture.
- **IMAP + local-LLM existence proofs (iCloud-compatible):** **herald-mail-app**
  (Go, active, iCloud preset, Ollama default, IMAP IDLE, semantic search, dry-run
  cleanup; FSL license), **emailops** (Rust, llama.cpp embedded), **imap-spam-cleaner**
  (Go, pluggable OpenAI/Ollama/SpamAssassin providers, spam score 0–100, move-never-
  delete), plus a tail of small Ollama+IMAP triage scripts.
- **No dominant open-source AI spam filter exists** — the niche is small projects
  with converging design. The convergent architecture is the thing to copy.

### Mechanics worth stealing (verified in source/README)

1. **Cascade before LLM** (spamguard, Mailwarden, rspamd-GPT): allow/deny lists →
   SPF/DKIM header checks → Bayesian/heuristics → LLM only for the uncertain band.
   70–80% of mail never reaches the LLM — exactly right for the 8GB-VRAM,
   LLM-first-GPU prod box. Cache verdicts per message.
2. **Asymmetric action policy** (Mailwarden, imap-spam-cleaner): act only on
   confident spam; unknown stays untouched in inbox; **move to Junk, never delete**;
   dry-run preview mode; append-only audit log of every verdict + reason.
3. **Cold-email/sender-reputation cascade** (inbox-zero `is-cold-email.ts`): cheap
   checks first — has this sender emailed before? have we ever replied? known
   sender-group match? — LLM last, and every verdict stores a human-readable reason.
4. **Prompt-to-rules compiler** (inbox-zero): user writes plain English once
   ("always keep school emails, junk anything from car dealerships"); LLM compiles
   it to structured, Zod-validated rule objects; runtime executes cheap rules, not
   free-text prompts. Perfect fit for the companion.
5. **Three-bucket triage router** (EAIA): ignore / notify / respond as the top
   decision, user-editable guidelines, human approval gates any send.
6. **Domain blocking reality**: iCloud server-side rules (max 500) have **no API** —
   icloud.com web UI only (verified; feature request open since 2020). Every project
   implements "permanently filter this domain" as an **own rules table + continuous
   daemon sweep** (imapfilter is the canonical engine; iCloud MCP servers do the
   same client-side with dryRun). IMAP IDLE + periodic full-sweep fallback.
7. **Folder-as-command UX** (unspammer): the daemon watches magic folders — drag a
   mail to "Block sender" or "Not junk" from ANY mail client (including the native
   iPhone Mail app) and the daemon reacts. Zero new UI for family members.
8. **Unsubscribe tiering** (gmail-ai-unsub, RFC 8058): parse `List-Unsubscribe`
   headers (typed TS lib exists: planetaryescape/list-unsubscribe) → one-click
   HTTPS POST (`List-Unsubscribe=One-Click`; dependable since Gmail/Yahoo's 2024
   bulk-sender mandate) → mailto: via SMTP → LLM browser-agent fallback for gnarly
   pages. Guardrails: skip protected categories (banks/gov/medical/school); only
   unsubscribe from DKIM-passing legit bulk mail — never raw spam (confirms address).
9. **Delivery extraction** (HA Mail-and-Packages, PackageTrackr): sender+subject
   allowlist as IMAP pre-filter → per-carrier tracking-number regex (USPS
   `9[2345]\d{15,26}`, Amazon order IDs) → LLM only for markup-less senders (Amazon)
   → then **decouple extraction from tracking**: hand numbers to 17track free tier
   or carrier APIs (ts-shipment-tracking, TypeScript) for live status.
10. **Check for schema.org JSON-LD first** (KItinerary): airlines/big retailers
    embed `Order`/`ParcelDelivery`/`FlightReservation` JSON-LD in email HTML — free
    structured data before any regex/LLM. KItinerary (KDE, active) is the canonical
    reservations→calendar extractor; its per-provider mini-extractor-script pattern
    is worth copying. Receipt Wrangler (AGPL, active) proves IMAP receipt→expense.

## Part 2 — Feature brainstorm

Grounded in existing hooks: tools registry (`backend/src/tools/`), companion context
assembly (`companionTurn.ts`), briefing, entities table (family members + aliases),
staged actions (`companionActions.ts`), HUD island, family audio digest, idle
scheduler, Open-Meteo weather.

### Calendar (Tier 1 — build first)

- **First-class family calendar store**: synced per-member iCloud calendars merged
  into a household calendar; HUD `IslandPageCalendar` becomes real; day/week views
  on Home with the premium (non-widget-y) treatment.
- **Companion calendar grounding**: a calendar block in `companionTurn.ts` context —
  "what's on today/this week", "when is Isabella's recital", conflict awareness
  ("you have overlapping things Thursday").
- **Write support**: "add a dentist appointment Friday at 3" → staged action →
  CalDAV PUT into the member's calendar (appears on their iPhone natively — this is
  the magic moment; no app install needed on phones).
- **Morning briefing fusion**: today's events + weather + reminders in the existing
  briefing; family audio digest gains "today at our house" segment.
- **Proactive companion moments** (the "good luck at your recital" ask): an idle-time
  job scans upcoming events and emits companion nudges — day-of good-luck messages,
  "leave by 5:10, traffic + game at 6", post-event "how was the recital?" follow-ups.
- **Event+weather fusion**: outdoor-looking events (softball, hike, picnic — LLM
  classification) cross-checked against Open-Meteo → "snow forecast for Saturday's
  game, might get cancelled" surfaced on Home ticker + companion.
- **Conflict/logistics sentinel**: two kids, two places, one time → flag it the
  evening before, not in the car.
- **Birthday/anniversary awareness** via CardDAV contacts sync → companion + ticker
  ("Grandma's birthday is Tuesday — want a reminder to call?").

### Contacts (Tier 1, cheap add-on)

- CardDAV sync into the `entities` table — enriches "who is Isabella" resolution the
  voice router already does, adds phone/email/birthday grounding for companion, and
  gives the family a shared address book view.

### Reminders (Mac EventKit relay — Tier 1.5)

- Read: "what's on my reminders list", grocery list on the fridge-HUD, briefing merge.
- Write: "remind me to sign the permission slip" → lands in real Apple Reminders,
  fires natively on their phone with Apple's own geofencing/time alarms — we get
  world-class delivery for free.
- Shared-list patterns: household chores list, shopping list visible on HUD + voice
  add from anywhere in the house.

### Find My / location (Tier 2 — the fragile crown jewel)

- **"Where is Isabella?"** voice/chat tool: device location → reverse-geocode →
  human answer ("at school", "on the way home — about 10 minutes out" using zones
  from the existing HA area/zone concepts).
- **Arrival/departure moments**: "Isabella just left practice"; companion says
  "Dad's 5 minutes away" on the kitchen speaker; door-greeting when someone arrives.
- **Home/away context for the house**: presence-aware routines (heat, lights, "last
  person left — doors locked?") feeding the planned routines engine (roadmap phase 3).
- **Safety utilities**: "ping Milo's iPad" (staged action w/ confirmation), low-battery
  alerts for kids' phones ("Isabella's phone is at 8% and she's at the mall").
- **Calendar × location fusion**: game starts at 6, kid's phone still at home at
  5:40 → nudge. This is the flagship "smart companion" demo.

### Mail (Road A — same trust level as calendar; mechanics from Part 1c)

The mail lane splits into a **guardian** (cleans), a **butler** (surfaces), and an
**extractor** (turns mail into structured app data). All local via Ollama; the
cascade design means most messages never touch the LLM.

Guardian (junk + hygiene):
- **AI junk weeding** per the convergent architecture: allowlist/denylist → SPF/DKIM
  → heuristics → local-LLM only for the uncertain band; move-to-Junk never delete,
  audit log, dry-run mode surfaced in Admin.
- **"Never again" domain blocking**: own rules table + IDLE daemon sweep (no iCloud
  rules API exists); companion command "block everything from this dealership" →
  prompt-to-rules compilation → permanent rule. Optionally suggest mirroring the top
  blocks as real iCloud web rules (manual, but survives our downtime).
- **Magic folders**: drag a message to "Block sender" / "Not junk" from the native
  iPhone Mail app → daemon reacts. Family-proof, zero new UI.
- **Unsubscribe concierge**: weekly digest "14 newsletters this week — unsubscribe
  from these 5?" → tiered unsub (RFC 8058 one-click → mailto → LLM browser-agent
  fallback), protected-category guardrails, only DKIM-passing legit senders.

Butler (triage + surfacing):
- **Three-bucket triage** (ignore/notify/respond) with per-member VIP senders and
  reply-history-based sender reputation; "anything important?" companion query.
- **Daily mail digest** into the existing briefing + family audio digest; ticker
  lines for the notify bucket ("Permission slip from Ms. Rivera needs signing").
- **Plain-English standing rules** via the prompt-to-rules compiler ("always tell me
  immediately about anything from the school district").
- **Send as action**: "email the teacher that Milo is sick" → staged, confirmed send
  via SMTP (1k/day cap — irrelevant at family scale).

Extractor (mail → app data):
- **Deliveries lane**: sender+subject pre-filter → carrier regex → LLM for Amazon →
  tracking numbers handed to carrier APIs/17track for live status → "arriving today"
  on HUD, "your package was delivered" companion moment.
- **Purchases/receipts → subscriptions ledger** (pairs with the Apple-receipt lane
  in Part 1b): order confirmations parsed to a household spend view.
- **Reservations → calendar**: JSON-LD first (flights/hotels embed it), LLM fallback
  → staged calendar events. KItinerary-style per-sender mini-extractors, hot-addable.
- **School/family logistics**: newsletter summarization + date extraction → proposed
  calendar events ("Spirit Day Friday, picture day moved to the 12th").

### Notes (Road C read-write, Road B read)

- Bidirectional bridge between the app's existing Notes store and Apple Notes:
  grocery list edited on iPhone shows on the fridge HUD and vice versa.
- Companion grounding: "what was on my packing list?" — notes recall alongside the
  existing memory/notes sources in companionTurn.

### Photos (zero-auth Shared Album first)

- **Family frame**: a link-shared iCloud album feeds HUD/ambient screens via the
  no-auth webstream endpoint (`icloud-shared-album` npm) — cheapest win in the whole
  program, ships in a day, survives ADP.
- Later: icloudpd or osxphotos ingest → local camera-NL-search (already shipped)
  over the family's full library; "show me photos from the beach trip" on the TV.

### iMessage (Road C, most speculative — separate consent conversation)

- Read lane only if ever built: "did Isabella text back?"; family-logistics
  extraction from group chats is powerful but is the most privacy-sensitive surface
  in the house — needs per-member opt-in and probably per-chat allowlists.
- Send lane is safer: companion/staged "text Dad we're leaving" via BlueBubbles REST.

### Health + AirTags (long tail)

- Health Auto Export → Bun endpoint: sleep/steps/workouts grounding ("how did I
  sleep?"), gentle companion nudges; per-member opt-in.
- AirTags via Find My cache reader on the Mac node: "where are the keys?" joins the
  existing Home Inventory story (physical stuff + location).

### Cross-cutting companion intelligence

- **Household rhythm model**: idle-time LLM precompute (existing background-processor
  band) summarizing the week ahead into a compact context block — cheaper than raw
  event dumps, powers ticker lines like "Busy Thursday: 3 activities".
- **Care-taking persona moments**: recital good-lucks, "first day of school tomorrow",
  "you got home late, want a quieter morning briefing?" — dedupe + rate-limit so it
  stays delightful, never naggy (one proactive nudge per event, quiet hours).
- **Privacy stance as a feature**: everything above runs local; the pitch is "Apple's
  data, your house, no cloud middleman." Per-member visibility controls (a teen can
  hide location from siblings but not parents, etc.) via existing per-profile gates.

### Suggested phasing

1. **Phase 1**: Apple account connection UI (ASP) + CalDAV calendar sync + read-only
   calendar on Home/HUD + companion grounding + briefing merge.
2. **Phase 2**: calendar write (staged actions), contacts/birthdays, event+weather
   fusion, proactive event nudges.
3. **Phase 3**: Mac EventKit relay for Reminders (read, then write).
4. **Phase 4**: Find My via pyicloud sidecar (opt-in Tier 2), "where is…", zones,
   arrival moments, calendar×location fusion.

Follow-up sweep additions to slot in: the **zero-auth shared-album family frame**
can ship any time (even before Phase 1 — no credentials needed); **Mail** joins
Phase 1/2 since it reuses the same ASP connection UX; **Notes/iMessage/Health/
AirTags** hang off the Mac-relay investment made in Phase 3 and should be judged
individually after it proves out.

## Key risks to carry into any plan

- ASP revocation on password change (silent 401s) — need detection + re-auth UX.
- Tier 2 stores main Apple passwords — encrypt via keystore, be explicit in UI.
- Tier 2 breaks 2–3×/year — pin timlaing/pyicloud, isolate as sidecar, degrade to
  "location unavailable" without touching calendar features.
- ADP on any member's account silently kills Tier 2 for that member — probe + surface.
- Trust-token lifetime is unknown — build the MFA re-verify flow into Admin from day 1.
- Find My polling drains phone batteries (forced wake + GPS fix per query) — see
  architecture rule 4: passive-first, on-demand, adaptive, per-device daily budget.
