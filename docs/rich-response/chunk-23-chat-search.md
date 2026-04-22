# Chunk 23 — Chat search (find-in-chat + search-all-chats)

## Goal

Ship the LM Studio-inspired conversation search (`[R14]` in the design doc) — **find-in-chat** within the current session and **search-all-chats** across history — backed by local SQLite FTS over the `messages` table. Zero network. This chunk is the last in the rollout; after it, the rich-response redesign is feature-complete against the design doc.

## Files

- `lokidoki/orchestrator/memory/chat_search.py` — new. `find_in_chat(session_id, query)` + `search_all_chats(query)` using SQLite FTS5 virtual table.
- `lokidoki/core/memory_schema.py` — add an FTS5 virtual table mirroring `messages(content, session_id, role, created_at)` + triggers to keep it in sync.
- `lokidoki/api/routes/chat.py` — add `GET /api/v1/chat/search` (cross-chat) and `GET /api/v1/sessions/{id}/search` (in-session).
- `frontend/src/components/chat/search/SearchDialog.tsx` — new. Top-bar search entry point (shadcn `Dialog`).
- `frontend/src/components/chat/search/FindInChatBar.tsx` — new. Inline bar opened by ⌘F (desktop) or a toolbar button (touch).
- `frontend/src/components/chat/search/SearchResultItem.tsx` — new.
- `frontend/src/components/chat/ChatWindow.tsx` — mount the find-in-chat bar; wire ⌘F.
- `tests/unit/test_chat_search.py` — new.
- `frontend/src/components/chat/search/__tests__/search.test.tsx` — new.

Read-only: `lokidoki/core/memory_schema.py`, `lokidoki/orchestrator/memory/store_schema.py`.

## Actions

1. **FTS5 table**:
   - Schema: `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, session_id UNINDEXED, role UNINDEXED, created_at UNINDEXED, content_rowid=rowid, tokenize="porter unicode61");`
   - Triggers on the `messages` table to keep FTS in sync on INSERT / UPDATE / DELETE.
   - One-time backfill pass for existing rows (a simple `INSERT INTO messages_fts SELECT ...`), guarded so it runs at most once (track via a schema-version row).

2. **Search functions**:
   - `find_in_chat(session_id, query, limit=20)` — FTS match within a single session, ranked by FTS bm25. Return `{message_id, snippet, created_at, role}`.
   - `search_all_chats(query, limit=50)` — same, across all sessions; include `session_id` and `session_title` in results.
   - Snippet extraction via FTS5 `snippet(...)`.

3. **API endpoints**:
   - `GET /api/v1/sessions/{session_id}/search?q=...` → `find_in_chat(...)`.
   - `GET /api/v1/chat/search?q=...` → `search_all_chats(...)`.
   - Both paginated (`?limit=`, `?offset=`).

4. **Frontend — find in chat**:
   - ⌘F / Ctrl+F opens `FindInChatBar` (an inline sticky bar at the top of the chat window).
   - Typing debounces (200 ms) and hits the session endpoint.
   - Results highlight the match within the message bubble; up/down arrows cycle; enter focuses the message.
   - Esc closes.

5. **Frontend — search all chats**:
   - Toolbar button + ⌘⇧F opens `SearchDialog`.
   - Input + result list with `SearchResultItem` components showing session title, snippet, timestamp.
   - Clicking a result navigates to the session and scrolls to the message.

6. **Offline invariants** — search is a local SQLite query; no network. Verify the code imports nothing from `httpx` / `fetch` in the search path.

7. **Onyx Material** — dialogs + bars use shadcn primitives (`Dialog`, `Input`, `Command`). No bespoke popover.

8. **Keyboard shortcuts on kiosk** — the touch kiosk doesn't have a keyboard; the toolbar button is the primary entry. Make sure the search UI is discoverable without ⌘F.

9. **Tests**:
   - FTS match returns expected snippets for known fixture content.
   - In-session search excludes other sessions' rows.
   - Backfill trigger populates FTS on a fresh db with existing messages.
   - Frontend: ⌘F opens the bar, results scroll into view, esc closes.

## Verify

```
pytest tests/unit/test_chat_search.py -v && npm --prefix frontend run test -- search && npm --prefix frontend run build
```

All tests pass. Manual: seed a chat with a handful of messages, open ⌘F, type a word present in a prior message, confirm highlight + navigation. Open cross-chat search dialog, confirm results span sessions.

## Commit message

```
feat(search): local chat search — find-in-chat + search-all-chats

Add a SQLite FTS5 virtual table mirroring messages, with triggers
to keep it in sync. Two endpoints surface in-session and cross-
session search. Frontend ships FindInChatBar (⌘F) and SearchDialog
(⌘⇧F + toolbar button) using shadcn primitives, with keyboard
cycling and navigate-to-message.

Zero network; all search is local SQLite.

Refs docs/rich-response/PLAN.md chunk 23.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
