# Chunk 1 — OpenAddresses preflight + per-state pinning

## Goal

After this chunk, the bootstrap can download (or read from the offline
bundle) a per-US-state OpenAddresses CSV bundle for every installed
map region whose `region_id` starts with `us-`. The downloaded archive
lands at
`data/maps/<region_id>/openaddresses.csv.gz` and is SHA-pinned in
`lokidoki/bootstrap/versions.py`. No indexer or search behavior
changes — chunk 2 is the consumer. This chunk is purely "get the bytes
on disk, verified, repeatable, offline-capable."

The pin is keyed by `region_id` so adding a new state in the future is
"pick a run URL, paste the sha256." The two states we need today are
`us-ct` and `us-fl` (already installed locally).

## Files

- `lokidoki/bootstrap/versions.py` — add a new `OPENADDRESSES_REGIONS:
  dict[str, dict[str, str]]` mapping `region_id` → `{url, sha256,
  size_bytes}`. Today populated for `us-ct` and `us-fl`.
- `lokidoki/bootstrap/preflight/openaddresses.py` — new module with
  `ensure_openaddresses_for(region_id, ctx)`. Idempotent: skip if
  destination file exists with correct size + sha256; otherwise
  download via `urllib.request` (no new dep), verify sha, atomic
  rename into place. Source resolves from
  `OPENADDRESSES_REGIONS[region_id]`; missing entry → `RuntimeError`
  with the pin-this-region instructions.
- `lokidoki/maps/store.py` — new private helper
  `_download_openaddresses_step(region_id, state, emit, cancel_event)`
  invoked from `install_region` immediately after the geocoder build
  step, only when `region_id.startswith("us-")` and the pin exists.
  Emits a `MapInstallProgress` event with
  `artifact="openaddresses"`, `phase="downloading_openaddresses"` /
  `"ready"`. Bytes-on-disk recorded in `state.bytes_on_disk["openaddresses"]`.
- `lokidoki/maps/models.py` — extend `MapRegionState` with a new
  `openaddresses_installed: bool = False` field (default keeps
  existing JSON forward-compatible). No schema migration needed —
  `dataclass(frozen=False)` defaults handle absent keys at load.
- `scripts/build_offline_bundle.py` — extend the manifest builder to
  include each `OPENADDRESSES_REGIONS` entry under a new
  `openaddresses/` subdirectory in the bundle.
- `scripts/verify_offline_bundle.py` — extend the manifest checker
  to validate the new entries.
- `tests/unit/bootstrap/test_preflight_openaddresses.py` — new. Covers:
  (a) skip-when-present idempotent path,
  (b) sha-mismatch raises and removes partial,
  (c) unknown-region raises with a clear pin-this-region message.
- `tests/unit/test_maps_install_openaddresses.py` — new. Stubs the
  preflight to write a tiny CSV; asserts `install_region` flips
  `openaddresses_installed = True` and emits the right SSE phases.

Read-only references:
- `lokidoki/bootstrap/preflight/world_overview.py` — closest pattern
  for "download + sha + atomic rename" preflight wiring.
- `lokidoki/bootstrap/preflight/planetiler_data.py` — closest pattern
  for sources directory layout + sha verification.
- `lokidoki/maps/store.py::_build_geocoder_step` — shape to mirror.

## Actions

1. **Pin the URLs in `versions.py`.** OpenAddresses publishes
   per-region zips via their runs system at
   `https://data.openaddresses.io/runs/<run_id>/<source>/statewide.zip`.
   Pick the most recent successful run for `us/ct/statewide.zip` and
   `us/fl/statewide.zip` from the [OpenAddresses run dashboard](https://batch.openaddresses.io/data).
   For each, `curl -sSI` the URL to confirm 200 + grab the
   content-length, then `curl -o /tmp/oa_<region>.zip <url>` and
   `sha256sum`. Add:
   ```python
   # OpenAddresses per-US-state parcel data — one entry per region we
   # support. Adding a new state means pinning a fresh run URL + sha.
   OPENADDRESSES_REGIONS: dict[str, dict[str, str | int]] = {
       "us-ct": {
           "url": "https://data.openaddresses.io/runs/<RUN_ID>/us/ct/statewide.zip",
           "sha256": "<HEX>",
           "size_bytes": <INT>,
           "filename": "us-ct.openaddresses.zip",
       },
       "us-fl": {
           "url": "...",
           "sha256": "...",
           "size_bytes": ...,
           "filename": "us-fl.openaddresses.zip",
       },
   }
   ```
2. **Write the preflight module.** Mirror the structure of
   `world_overview.py` — async function `ensure_openaddresses_for(
   region_id, ctx)`, step id `f"download-openaddresses-{region_id}"`,
   `StepLog` events, `RuntimeError` with operator-friendly text on
   bad sha. Destination path:
   `ctx.data_path() / "maps" / region_id / "openaddresses.zip"`.
   Inside the zip is a single CSV — extract it lazily in chunk 2,
   not here. (Keep the ZIP intact for offline-bundle parity.)
3. **Wire into `store.py::install_region`.** After the geocoder
   build step, if the pin exists for `region_id`, run the OA download
   step. On success, set `state.openaddresses_installed = True` and
   record bytes. On failure, log + continue — OA is additive, the
   region is still usable without it (chunk 4's UI will show a tag).
4. **Extend the offline bundle scripts.** `build_offline_bundle.py`
   must mirror each `OPENADDRESSES_REGIONS` entry into
   `<bundle>/openaddresses/<region_id>.openaddresses.zip` and write
   the entry to the manifest. `verify_offline_bundle.py` must
   re-check sha + size.
5. **Tests.**
   - `test_preflight_openaddresses.py`: build a tiny synthetic ZIP
     in `tmp_path`, host it via `pytest`'s `monkeypatch` against an
     `urllib.request` stub. Cover: success path writes file +
     correct sha; mismatch raises; idempotent skip when file already
     correct.
   - `test_maps_install_openaddresses.py`: monkeypatch the preflight
     to write a fixture file, run `install_region` for a stub region
     id `us-test`, assert SSE phases + state flag flip.

## Verify

```
uv run pytest tests/unit/bootstrap/test_preflight_openaddresses.py \
              tests/unit/test_maps_install_openaddresses.py -q \
  && uv run python -c "from lokidoki.bootstrap.versions import OPENADDRESSES_REGIONS; \
        assert {'us-ct','us-fl'} <= set(OPENADDRESSES_REGIONS.keys()), OPENADDRESSES_REGIONS.keys(); \
        for r,v in OPENADDRESSES_REGIONS.items(): \
            assert v['sha256'] and len(v['sha256'])==64, r; \
            assert v['size_bytes'] > 1_000_000, r; \
        print('OK', list(OPENADDRESSES_REGIONS.keys()))"
```

## Commit message

```
feat(maps): bootstrap preflight for per-state OpenAddresses parcel data

Pins OpenAddresses statewide ZIPs for us-ct and us-fl in versions.py
and adds a preflight + install-pipeline step that materializes them
under data/maps/<region_id>/openaddresses.zip. Indexer wiring lands
in chunk 2 — this chunk only puts verified bytes on disk and into
the offline bundle.

Refs docs/roadmap/geocode-coverage/PLAN.md chunk 1.
```

## Deferrals

(Empty.)
