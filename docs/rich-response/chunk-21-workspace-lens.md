# Chunk 21 — Workspace lens (persona + memory scope)

## Goal

Treat "workspace" as a **persona + memory scope lens**, not a multi-tenant folder tree. A workspace bundles: the active persona (from `loki-doki-personas`), an attached-knowledge scope, response tone/layout preferences, and a history slice that counts as "in context" for memory retrieval. This keeps LokiDoki single-user + local while making scoped context user-legible.

## Files

- `lokidoki/orchestrator/workspace/__init__.py` — new.
- `lokidoki/orchestrator/workspace/types.py` — new. `Workspace` dataclass.
- `lokidoki/orchestrator/workspace/store.py` — new. SQLite-backed list/get/set/delete.
- `lokidoki/orchestrator/workspace/resolver.py` — new. `resolve_active_workspace(session) -> Workspace` — reads from session state; falls back to a default workspace.
- `lokidoki/orchestrator/core/pipeline.py` — load the active workspace at turn start, thread into pipeline context.
- `lokidoki/orchestrator/core/pipeline_phases.py` — pass workspace preferences into mode derivation (e.g. default mode per workspace).
- `lokidoki/api/routes/workspaces.py` — new. CRUD endpoints.
- `frontend/src/components/workspace/WorkspacePicker.tsx` — new. Compact dropdown in the chat header.
- `frontend/src/components/workspace/WorkspaceEditor.tsx` — new. Edit attached knowledge, default mode, tone.
- `tests/unit/test_workspace.py` — new.
- `frontend/src/components/workspace/__tests__/picker.test.tsx` — new.

Read-only: `loki-doki-personas` references, existing memory tier code (per MEMORY.md memory phases M0–M6 shipped).

## Actions

1. **Workspace shape** (`types.py`):

   ```python
   @dataclass
   class Workspace:
       id: str                                # slug-friendly
       name: str
       persona_id: str                        # points to loki-doki-personas entry
       default_mode: Literal["direct","standard","rich","deep","search","artifact"] = "standard"
       attached_corpora: tuple[str, ...] = () # bootstrap-materialized corpus ids
       tone_hint: str | None = None           # short phrase, appended to persona system prompt
       memory_scope: Literal["global", "workspace"] = "workspace"  # which memory slice to query
   ```

2. **Default workspace** — created at first run with `persona_id = "default"`, default mode `standard`, no attached corpora, global memory. Every user has at least one workspace.

3. **Store** (`store.py`):
   - SQLite table `workspaces`.
   - CRUD: `list_workspaces()`, `get_workspace(id)`, `create_workspace(...)`, `update_workspace(id, **fields)`, `delete_workspace(id)` (rejects deleting the default).
   - Active workspace id stored in the existing sessions table as a new column `active_workspace_id` (use the repo's migration pattern).

4. **Resolver** — `resolve_active_workspace(session)`:
   - Read `session.active_workspace_id`.
   - Fetch from store; if missing, return the default workspace and log a warning.
   - Cache per-request (workspace does not change mid-turn).

5. **Pipeline integration**:
   - Load workspace in the pre-parse / initial phase (earliest point where session context is available).
   - Pass `workspace.default_mode` into Chunk 12's `derive_response_mode` as a lower-priority fallback than `user_override` but higher than pure derivation.
   - Pass `workspace.persona_id` into synthesis system-prompt composition.
   - Pass `workspace.attached_corpora` into the document/memory retrieval layer as a filter.
   - Pass `workspace.memory_scope` to memory queries so "workspace" scope returns only turns that happened in sessions tied to this workspace.

6. **API endpoints** (`api/routes/workspaces.py`):
   - `GET /api/v1/workspaces` — list.
   - `GET /api/v1/workspaces/{id}` — detail.
   - `POST /api/v1/workspaces` — create.
   - `PUT /api/v1/workspaces/{id}` — update.
   - `DELETE /api/v1/workspaces/{id}` — reject for default.
   - `PUT /api/v1/session/active-workspace` — set the session's active workspace.

7. **Frontend**:
   - `WorkspacePicker` in the chat header (shadcn `DropdownMenu`) — select active workspace, open editor.
   - `WorkspaceEditor` — full editor in a shadcn `Dialog`. Edits use `ConfirmDialog` for destructive operations; never `window.confirm`.
   - The picker shows the active persona's avatar (from `loki-doki-personas` assets, bootstrap-materialized).

8. **Offline invariants** — workspace data is purely local SQLite. Persona content resolves from the local personas directory. Attached corpora ids refer to local bootstrap-downloaded data. No remote anything.

9. **Tests**:
   - Default workspace always exists and cannot be deleted.
   - Switching active workspace persists across sessions.
   - Memory scope = "workspace" filters out cross-workspace memory hits.
   - Default mode from workspace flows into `derive_response_mode` only when the user didn't override.

## Verify

```
pytest tests/unit/test_workspace.py tests/unit/test_response_mode.py -v && npm --prefix frontend run test -- picker && npm --prefix frontend run build
```

All tests pass. Manual: create a "Car Road Trip" workspace with default mode = `rich` and a "driving-assistant" persona; switch to it; ensuing turns adopt the persona tone and default to rich mode without explicit override.

## Commit message

```
feat(workspace): persona + memory scope lens

Workspaces bundle persona_id, default response mode, attached
corpora, tone hint, and memory scope. The store is local SQLite;
the picker sits in the chat header; the editor uses shadcn
Dialog + ConfirmDialog (no window.confirm). Active workspace is
per-session, resolved at turn start, threaded into mode derivation
and memory retrieval.

Single-user, offline, no multi-tenant folder tree.

Refs docs/rich-response/PLAN.md chunk 21.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
