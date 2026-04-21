# Chunk 19 — Artifact security foundation (sandboxed iframe + CSP)

## Goal

Lay the **security-first** foundation for artifacts before any UI ships. Sandboxed iframe, strict CSP, URL rejection for remote resources, size cap, version immutability. This chunk implements the scaffold and validation rules; Chunk 20 builds the UI on top. A sloppy ordering where UI ships before sandboxing is a release-blocking vulnerability — that's why this chunk comes first.

No user-visible artifact yet. Infrastructure only.

## Files

- `lokidoki/orchestrator/artifacts/__init__.py` — new.
- `lokidoki/orchestrator/artifacts/types.py` — new. `Artifact`, `ArtifactVersion`, `ArtifactKind` (`html` | `svg` | `js_viz`).
- `lokidoki/orchestrator/artifacts/validator.py` — new. `validate_artifact(artifact) -> None | raises ArtifactValidationError`. Enforces size cap, URL rejection, forbidden API usage.
- `lokidoki/orchestrator/artifacts/store.py` — new. Artifact persistence + immutable version bumps.
- `frontend/src/components/chat/artifact/SandboxedFrame.tsx` — new. `<iframe sandbox srcdoc>` wrapper with strict CSP injection + size guard.
- `frontend/src/components/chat/artifact/csp.ts` — new. Canonical CSP string + helpers.
- `frontend/src/lib/artifact-rpc.ts` — new. Typed `postMessage` RPC for save/export only. No other channels.
- `tests/unit/test_artifact_validator.py` — new.
- `frontend/src/components/chat/__tests__/sandbox.test.tsx` — new.

Read-only: design doc §17.4.1.

## Actions

1. **Types** (`artifacts/types.py`):

   ```python
   class ArtifactKind(str, Enum):
       html = "html"
       svg = "svg"
       js_viz = "js_viz"

   @dataclass(frozen=True)
   class ArtifactVersion:
       version: int
       content: str              # raw HTML/SVG/JS
       created_at: str
       size_bytes: int

   @dataclass
   class Artifact:
       id: str
       kind: ArtifactKind
       title: str
       versions: list[ArtifactVersion]   # append-only
       chat_turn_id: str
   ```

2. **Validation rules** (`validator.py`) — each rule runs on every version before persistence. Failure raises `ArtifactValidationError(rule, detail)`:
   - **Size cap**: `len(content.encode("utf-8")) <= 256 * 1024`.
   - **No remote URLs**: parse the content; reject if any `src` / `href` / `url()` / `import` / `@import` references a scheme other than `data:` or `blob:`. Relative paths are rejected too — artifacts are self-contained.
   - **No disallowed APIs**: reject content containing `eval(`, `new Function(`, `fetch(`, `XMLHttpRequest`, `import(`, `navigator.serviceWorker`, `WebSocket(`.
   - **No forms without explicit need**: reject `<form` unless the artifact kind + title permits it; conservative default is to reject.
   - **No top-level navigation**: reject `window.top`, `window.parent.location`.
   - Use an HTML/JS parser where possible (a simple text scan is acceptable as a first pass; note the limitation in `## Deferrals`).

3. **Canonical CSP** (`csp.ts`):

   ```ts
   export const ARTIFACT_CSP = [
     "default-src 'none'",
     "script-src 'self' 'unsafe-inline'",   // inside the sandbox only
     "style-src 'self' 'unsafe-inline'",
     "img-src data: blob:",
     "font-src 'self'",
     "connect-src 'none'",
     "frame-ancestors 'self'",
     "form-action 'none'",
     "base-uri 'none'",
   ].join("; ");
   ```

4. **SandboxedFrame** (`SandboxedFrame.tsx`):
   - Renders `<iframe sandbox="allow-scripts" srcDoc={composedHtml}>`.
   - `composedHtml` wraps the artifact content with a `<meta http-equiv="Content-Security-Policy" content="...">` header.
   - **Sandbox flags explicitly omitted**: `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`, `allow-pointer-lock`. Only `allow-scripts`.
   - Maximum render area bounded (e.g. 800×600 default, user can expand but never beyond viewport).
   - Listens for `postMessage` only from the known child origin; rejects everything else.

5. **Artifact RPC** (`artifact-rpc.ts`):
   - Typed message shape: `{kind: "save", payload: string}` | `{kind: "export", format: "html" | "svg"}`.
   - Any other message kind is logged and dropped.
   - Host never posts INTO the sandbox — communication is strictly child-to-host.

6. **Store** (`store.py`):
   - Artifacts live in a new SQLite table `artifacts(id TEXT PRIMARY KEY, kind TEXT, title TEXT, chat_turn_id TEXT)` and `artifact_versions(artifact_id TEXT, version INTEGER, content BLOB, size_bytes INTEGER, created_at TEXT, PRIMARY KEY(artifact_id, version))`.
   - `create_artifact(kind, title, content)` → validates, writes version 1, returns the id.
   - `append_version(artifact_id, content)` → validates, computes `version = max_existing + 1`, appends.
   - No update/delete of prior versions.

7. **Tests**:
   - Validator: craft adversarial payloads (remote CDN script tag, inline `fetch`, 512 KB content, `new Function`) and assert each raises the correct rule.
   - Store: `append_version` increments monotonically; prior versions are immutable.
   - Sandbox: rendered iframe has exactly the canonical CSP; no `allow-same-origin`.
   - RPC: malformed or unsolicited messages are dropped without crashing the host.

8. **Wiring**: no artifact renders in the UI yet. Chunk 20 mounts it.

## Verify

```
pytest tests/unit/test_artifact_validator.py -v && npm --prefix frontend run test -- sandbox && npm --prefix frontend run build
```

All tests pass. Manual: attempt to render an artifact with a CDN `<script src="https://...">` → validator rejects.

## Commit message

```
feat(artifacts): security-first sandbox foundation

Add the artifact type model, strict validator (size cap, remote-URL
rejection, disallowed-API rejection), immutable version store,
sandboxed iframe wrapper with a canonical strict CSP, and a typed
child-to-host RPC. No artifact renders in the UI yet — chunk 20
builds on this foundation.

Shipping artifact UI before this scaffold would be a release-blocking
XSS + offline-violation risk; that's why the security work lands
first.

Refs docs/rich-response/PLAN.md chunk 19.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
