# Chunk 12 — Serve nested static dirs (`/sprites`) from FastAPI

## Goal

After this chunk, `GET /sprites/maps-sprite.json` returns the JSON file
with `application/json`, `GET /sprites/maps-sprite.png` returns the PNG
with `image/png`, and MapLibre can load the sprite that chunks 9 and 10
built. Any future nested static directory under `frontend/dist/` can
follow the same mount pattern. The catch-all at
[lokidoki/main.py:237](../../../lokidoki/main.py#L237) currently routes
every nested path to the SPA shell, so `GET /sprites/maps-sprite.png`
returns `index.html` with `text/html` + HTTP 200, silently breaking the
sprite load. This is the hidden-in-prod bug behind every "Image X could
not be loaded" warning in the browser console; chunks 9 + 10 look
implemented but ship invisible because the browser never sees a real
sprite payload.

The smallest fix is a one-line `StaticFiles` mount, mirroring the
existing `/assets` mount right above it, plus adding `sprites/` to the
catch-all's prefix blacklist so a *missing* sprite file returns 404
instead of the SPA shell.

## Files

- `lokidoki/main.py` — add
  `app.mount("/sprites", StaticFiles(directory="frontend/dist/sprites"), name="sprites")`
  directly after the existing `/assets` mount at
  [main.py:62](../../../lokidoki/main.py#L62), guarded by an
  `os.path.exists` check in the same shape. Extend the catch-all
  prefix blacklist at [main.py:241](../../../lokidoki/main.py#L241)
  from `("assets/", "static/", "media/")` to also include
  `"sprites/"` so a missing sprite file 404s cleanly instead of
  returning the SPA shell.
- `tests/unit/test_frontend_static.py` — **new**. Three tests using
  `fastapi.testclient.TestClient`:
  - `test_sprite_png_returns_png_content_type` — writes a small PNG
    to a temp `frontend/dist/sprites/maps-sprite.png`, monkey-patches
    the app's static root to `tmp_path`, asserts the GET returns
    status 200 and `content-type` starts with `image/png`.
  - `test_sprite_json_returns_json_content_type` — same shape,
    asserts `content-type` starts with `application/json`.
  - `test_missing_sprite_returns_404` — asserts
    `GET /sprites/not-real.png` returns 404 with no HTML body
    (anti-regression on the SPA-shell fallthrough).

Read-only:
- `frontend/public/sprites/` + `frontend/dist/sprites/` — the
  on-disk assets chunks 9 + 10 already produce. This chunk only
  teaches the server to serve them; do not touch the sprite assets.
- `frontend/src/pages/MapsPage.tsx:409` — confirms the runtime
  expects `/sprites/maps-sprite` as the sprite URL base; no edit.

## Actions

**Note:** the two one-line edits (mount + catch-all blacklist) were
pre-applied as an unstaged fast-fix when this chunk was authored —
verify their presence in `lokidoki/main.py` before doing anything
else; if they're missing, apply them per step 1/2. If they're
already there, this chunk's net-new work is the regression test
in step 3.

1. **Verify the static mount** in `lokidoki/main.py` directly after
   the `/assets` mount. Shape (guarded by `os.path.exists` so a
   repo without a built frontend still boots):
   ```python
   if os.path.exists("frontend/dist/sprites"):
       app.mount("/sprites", StaticFiles(directory="frontend/dist/sprites"), name="sprites")
   ```
2. **Verify the catch-all blacklist** at the catch-all near
   [main.py:241](../../../lokidoki/main.py#L241) includes
   `"sprites/"` so a missing sprite file 404s instead of returning
   the SPA shell. Without this, a typo in a sprite URL keeps hiding
   as "HTML returned with 200" — the very bug this chunk fixes.
3. **Tests.** Use `TestClient(app)` from `fastapi.testclient`. For
   the content-type tests, it's fine to write the PNG as a 4-byte
   stub (`b"\x89PNG"` header only) — Starlette sets `content-type`
   from the file extension, not from sniffing the bytes. Use
   `tmp_path` via a `monkeypatch.chdir(tmp_path)` + a staged
   `frontend/dist/sprites/` directory to avoid depending on the
   real repo's built assets.
4. **Manual verification.** After `./run.sh` finishes a restart,
   run the curl probe command in `## Verify`. The content-type
   flip (`text/html` → `image/png`) is the load-bearing signal.

## Verify

```
uv run pytest tests/unit/test_frontend_static.py -q \
  && test -f frontend/dist/sprites/maps-sprite.png \
  && python3 -c "from fastapi.testclient import TestClient; \
        import os; os.chdir('.'); \
        from lokidoki.main import app; c = TestClient(app); \
        r = c.get('/sprites/maps-sprite.png'); \
        assert r.status_code == 200, r.status_code; \
        ct = r.headers.get('content-type',''); \
        assert ct.startswith('image/png'), ct; \
        print('OK content-type=', ct)"
```

## Commit message

```
fix(server): mount /sprites as static, keep SPA shell off asset paths

The FastAPI catch-all was handing back index.html (text/html, 200) for
any nested path that wasn't /assets, /static, or /media, so
/sprites/maps-sprite.png (written by chunks 9 + 10) resolved to the
SPA shell instead of the PNG. MapLibre parsed HTML as a sprite and
silently failed every icon-image lookup (route shields, POI icons),
which looked like chunk 9/10 never shipped even though the assets
were on disk.

Add a StaticFiles mount for /sprites mirroring /assets, and extend
the catch-all prefix blacklist so a *missing* sprite file returns
404 instead of the SPA shell. New unit tests pin both the mount's
content-type response and the 404 behavior so this can't silently
regress again.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 12.
```

## Deferrals

(Empty.)
