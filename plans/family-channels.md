# Family Channels - plan (#9)

Shared, multi-person AI conversation spaces: a named room ("Vacation planning", "Dinner
ideas") where more than one family member AND the companion talk in one timeline, each human
message attributed to its sender, the AI joinable by @-mention. Inspired by Open WebUI
Channels. This is the one XL item from the competitive-enhancements review: it is a new
subsystem, not an extension, because the codebase assumes conversations are single-user.

No em dashes anywhere in this doc (house rule).

## Why this is XL (the four things it touches)

Grounded against the code:

1. **Schema.** `conversations` has a single `userId` (notNull) and a single nullable
   `characterId` (`backend/src/db/schema.ts:308`). `messages` has `role` in
   `['user','assistant','system']` with no "which human" concept (`schema.ts:328`). There is
   no membership table anywhere.
2. **Auth.** Every read/write in `backend/src/routes/chat.ts` gates on
   `conversations.userId === user.id` (lines 81, 112, 145, 164, 188, 253, 432, 517, 634).
   Channels need membership-based authorization instead.
3. **Realtime.** Today a reply streams over per-request SSE to the one client that asked. A
   channel must fan out new messages (human and assistant) to every connected member. The
   `backend/src/lib/drop/presence.ts` SSE presence/broadcast model is the reusable precedent.
4. **Memory.** `memories`/`entities` are keyed `(userId, characterId)`
   (`backend/src/memory/`). A shared room needs an explicit policy for whose memory the AI
   reads and writes, decided up front.

## Design principle: parallel tables, do not destabilize 1:1 chat

Do NOT retrofit `channels` onto the existing `conversations`/`messages` tables. The 1:1 chat
path is load-bearing (streaming render contract, memory sweep, titles, regenerate/edit) and
mixing a `senderUserId` concept into it risks the whole chat surface. Instead add parallel
`channels` + `channel_members` + `channel_messages` tables and a parallel route group, reusing
the shared turn engine (`runCompanionTurn`) for AI participation. Fold the two together later
only if it proves warranted.

## Schema (new)

```
channels
  id            text pk
  name          text notNull
  createdBy      text -> users.id
  characterId    text -> characters.id (nullable; the room's companion)
  createdAt      integer(ts)
  archivedAt     integer(ts) nullable

channel_members
  id            text pk
  channelId      text -> channels.id (cascade)
  userId         text -> users.id (cascade)
  role           text ['owner','member']  // owner can add/remove members, rename, archive
  joinedAt       integer(ts)
  lastReadAt      integer(ts) nullable      // unread badge
  UNIQUE(channelId, userId)

channel_messages
  id            text pk
  channelId      text -> channels.id (cascade)
  senderUserId   text -> users.id (nullable = assistant/system)
  role           text ['user','assistant','system']
  content        text notNull
  sources        text nullable             // reuse the #8 citation JSON shape
  createdAt      integer(ts)
```

Add CREATE TABLE IF NOT EXISTS mirrors in `backend/src/db/index.ts runMigrations()` (the
authoritative path; the migrator journal stopped at 0016), plus the Drizzle table defs.

## Auth

New middleware `requireChannelMember` (and `requireChannelOwner`): resolves the channel id
from the route param, checks `channel_members` for the current user, 403 otherwise. Applies to
every channel read/write. Content-ceiling and per-user permissions still apply per member: a
member's content ceiling gates what THEY see and what the AI will say when addressed by them
(reuse `resolveTurnContext` per sender).

## Routes (new group `/api/channels`)

- `POST /` create (creator becomes owner + first member)
- `GET /` list channels the user is a member of (with unread counts from `lastReadAt`)
- `GET /:id` channel + members + recent messages (member-gated)
- `POST /:id/members` / `DELETE /:id/members/:userId` (owner-gated)
- `POST /:id/messages` post a human message; if it @-mentions the companion, trigger an AI turn
- `POST /:id/read` update `lastReadAt`
- `PATCH /:id` rename/archive (owner)
- `GET /:id/stream` SSE: subscribe to this channel's live events (new messages + AI tokens)

## Realtime fan-out

Model it on `backend/src/lib/drop/presence.ts`: an in-process per-channel subscriber registry.
When a human posts or the AI streams, publish events to all subscribers of that channel id.
The AI turn runs through `runCompanionTurn` (reuse verbatim) with `onToken`/`onEvent` piped
into the channel publisher instead of a single HTTP response, so tokens stream to every
connected member. Persist the finished assistant message to `channel_messages` (with `sources`
from the #8 capture path).

## Memory policy (decide before Phase 2)

Recommended v1 policy, least-surprising and privacy-safe:
- The AI READS only channel-scoped context (the channel's own recent messages + a rolling
  channel summary), NOT any member's private user-global memories. A shared room should not
  leak one person's private memories to the group.
- The AI WRITES no durable per-user memories from channel turns in v1 (channel content stays in
  the channel). Optionally add a channel-scoped memory later (new scope on `memories`).
This keeps the existing `(userId, characterId)` memory model untouched.

## UI

- Channel list entry point (a "Channels" section in the chat area / left rail).
- A `ChannelView` reusing `MessageList` with a per-sender identity variant (avatar + name for
  human senders; the companion renders as today). `ChatMessage` currently assumes
  user/assistant only, so add an optional `sender` (name/avatar) prop path rather than
  branching the 1:1 renderer.
- An @-mention affordance for the companion in the composer.
- Member management (owner): add/remove household members, rename, archive.
- Unread badges from `lastReadAt`.

## Phased delivery (gated)

- **Phase 0.** This plan + schema review. Confirm the memory policy with the user.
- **Phase 1.** Schema + tables + create/list/join + read-only shared timeline (members see each
  other's messages, no AI yet). No realtime (poll on open). Proves membership auth + attribution.
- **Phase 2.** AI participation: @-mention triggers a `runCompanionTurn` posted into the channel.
  Still no live fan-out (the poster sees the reply; others on next load).
- **Phase 3.** Realtime SSE fan-out (the presence model) so all members see messages + AI tokens
  live.
- **Phase 4.** Polish: unread badges, member management UI, channel summary, optional
  channel-scoped memory.

## Tests

Per phase, mine: migration applies on a fresh + existing DB; `bun build` of touched entries
(note: the full `backend/src/index.ts` build currently fails on a pre-existing missing
`chromium-bidi` dep, so verify touched modules in isolation); membership-auth unit tests
(member can read, non-member gets 403; owner-only actions reject members). Yours: two profiles
in one channel see each other's messages, and an @-mention produces an AI reply visible to both
(live in Phase 3).

## Risks

- Highest-risk item in the initiative: it touches auth, the streaming contract, and memory
  scoping at once. The parallel-tables approach is the primary de-risk (keeps 1:1 chat
  untouched). Do not shortcut it by adding `senderUserId` to the existing `messages` table.
- Memory leakage across members is the subtle privacy trap: default to channel-scoped-only
  reads (above) and revisit only deliberately.
- Fan-out correctness (a member connecting mid-stream, reconnects, backpressure) is where
  realtime bugs live; lean on the proven `drop/presence.ts` patterns rather than inventing.
