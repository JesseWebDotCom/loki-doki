# Chunk 6 — Install pipeline resilience: atomic indexer + skip-if-hash + UI clear

## Goal

After this chunk, re-installing a region cannot leave the user in a
worse state than before they clicked the button. Three concrete
defects observed in production today are fixed:

1. The geocoder indexer overwrites the existing `geocoder.sqlite`
   in-place, so a crash mid-build (or a server restart) leaves a
   broken partial DB AND wipes the previous good one. **Fix:** write
   to `geocoder.sqlite.partial`, atomic-rename only on a successful
   build.
2. The PBF download in `store._download_to` re-fetches the file even
   when an identical PBF is already on disk. **Fix:** if the
   destination exists and its sha matches the catalog pin, skip the
   download and emit a `verifying` → `extracting` event sequence
   directly.
3. The frontend `MapsSection.streamProgress.finishInstall` removes
   the region from the `installing` set but never clears
   `progress[regionId]`, so a dead install keeps showing
   *"Indexing addresses 29k rows"* forever. **Fix:** clear the
   progress entry too. Also poll `/regions/{id}/progress` once on
   tab-mount per visible region — if the server says `idle` and the
   stored state has a non-`done` phase, clear it.

Together these three small fixes mean (a) a re-install that crashes
keeps the previous index intact, (b) re-installs are cheap when the
PBF didn't change, and (c) the UI never lies about what the install
pipeline is doing.

## Files

- `lokidoki/maps/geocode/fts_index.py` — change `build_index` to
  open the connection on `output_db.with_suffix(".sqlite.partial")`,
  do all the FTS5 inserts there, and on successful return
  `os.replace(partial, output_db)` plus delete the partial WAL/SHM
  siblings if any. On any exception, delete the partial files and
  re-raise. Existing callers see the same final-path semantics.
- `lokidoki/maps/store.py` — extend `_download_to` to short-circuit
  when `dest.exists()` and `_sha256_of(dest) == expected_sha256`.
  Emit a single `verifying` progress event with
  `bytes_done=bytes_total=size_on_disk` and return the existing
  byte count. Add the helper `_sha256_of(path: Path) -> str` next
  to `_download_to`.
- `frontend/src/components/settings/MapsSection.tsx` — in the
  `finishInstall` closure inside `streamProgress`, add a
  `setProgress(prev => { const n = {...prev}; delete n[regionId];
  return n; })` call. Also add a one-shot effect on mount that for
  each currently-installing-or-progress region issues a single
  `fetch(${API}/regions/${id}/progress, {method: 'GET'})` to read
  the SSE init event; if it's `{status: "idle"}`, clear the local
  progress + installing entries for that region and trigger
  `reload()`.
- `tests/unit/test_geocode_fts_build.py` — extend with a new test
  `test_build_index_atomic_on_failure`: monkeypatch `_flush` to
  raise `RuntimeError` on the second call; assert that an existing
  pre-build `geocoder.sqlite` file (touched into place beforehand)
  is unchanged after the failed build, and that no
  `.sqlite.partial` artifact survives.
- `tests/unit/test_maps_store_download.py` — new (or extend the
  existing nearest neighbour). Cover `_download_to` skip-if-hash
  path: pre-write a file with known content + sha, monkeypatch the
  `httpx.AsyncClient.stream` to raise (so any actual network call
  blows the test), assert the function returns the byte count
  without making a request and emits a single `verifying` progress
  event.
- `frontend/src/components/settings/__tests__/MapsSection.test.tsx`
  — add `it("clears stale progress when install task disappears")`:
  mount with a fake EventSource that fires `onerror` after one
  `building_geocoder` event, assert the row no longer renders
  *"Indexing addresses…"* text after the error.

Read-only:
- `lokidoki/api/routes/maps.py` — the `/regions/{id}/progress`
  endpoint already returns `{status: "idle"}` when no install is
  active. Frontend uses that as the recovery signal.

## Actions

1. **Atomic indexer.** In `fts_index.build_index`:
   ```python
   partial = output_db.with_suffix(output_db.suffix + ".partial")
   for sibling in (partial, partial.with_suffix(partial.suffix + "-wal"),
                   partial.with_suffix(partial.suffix + "-shm")):
       if sibling.exists():
           sibling.unlink()
   conn = _open_db(partial)
   try:
       # ... existing pyosmium loop, _flush(conn, ...) calls ...
       conn.close()
       if output_db.exists():
           output_db.unlink()
       partial.replace(output_db)
       return stats
   except BaseException:
       try:
           conn.close()
       except Exception:
           pass
       for sibling in (partial,
                       partial.with_suffix(partial.suffix + "-wal"),
                       partial.with_suffix(partial.suffix + "-shm")):
           if sibling.exists():
               sibling.unlink()
       raise
   ```
   The previous good `geocoder.sqlite` is touched only by the
   atomic `replace` — until then, it stays intact.
2. **Skip-if-hash in `_download_to`.** Insert near the top:
   ```python
   if expected_sha256 and dest.exists():
       try:
           existing = _sha256_of(dest)
       except OSError:
           existing = ""
       if existing.lower() == expected_sha256.lower():
           size = dest.stat().st_size
           progress_cb(size, size)
           return size
   ```
   Add `_sha256_of` as a 6-line helper that streams the file in
   1 MB chunks. No new dep — `hashlib` is already imported.
3. **Frontend `finishInstall` clear.** Already documented above —
   one extra `setProgress` mutation. Verify the
   `MapsSection.test.tsx` that mocks EventSource still passes.
4. **Frontend stale-state poller on mount.** A `useEffect`
   triggered by `loaded` flipping true: for each region whose state
   has a `progress` entry whose `phase` is not `"complete"`, hit
   `${API}/regions/${id}/progress` (single-shot fetch with no
   `text/event-stream` accept; the FastAPI handler emits one
   `data: {"status": "idle"}` line and closes when nothing is
   active). If parse yields `status: "idle"`, clear that region's
   progress + installing entries and call `reload()`.
5. **Tests** as listed; keep them tight.

## Verify

```
uv run pytest tests/unit/test_geocode_fts_build.py \
              tests/unit/test_maps_store_download.py \
              tests/unit/bootstrap/test_preflight_world_overview.py -q \
  && (cd frontend && npx vitest run src/components/settings/__tests__/MapsSection.test.tsx) \
  && uv run python -c "from pathlib import Path; from lokidoki.maps.store import _sha256_of; \
        p = Path('/tmp/_ld_chunk6_smoke'); p.write_bytes(b'x'*1024); \
        h = _sha256_of(p); \
        assert len(h) == 64, h; \
        p.unlink(); print('OK sha helper:', h[:12])"
```

## Commit message

```
fix(maps): atomic geocoder build + skip-if-hash + clear stale UI progress

- fts_index.build_index now writes to geocoder.sqlite.partial and
  atomic-renames only on success, so a crash mid-build no longer
  destroys the previous good index.
- store._download_to short-circuits when the destination exists and
  its sha matches the catalog pin; re-installs no longer redownload
  unchanged 462 MB Geofabrik PBFs.
- MapsSection.streamProgress.finishInstall clears progress[regionId]
  on close, and a one-shot mount poll against /regions/{id}/progress
  recovers from server-restart-while-install-was-running by clearing
  the stale "Indexing addresses 29k rows" forever-state.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 6.
```

## Deferrals

(Empty.)
