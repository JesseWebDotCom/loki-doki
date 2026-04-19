# Chunk 1 — Pin tippecanoe + valhalla prebuilt binaries via bootstrap

## Goal

Make `tippecanoe` and `valhalla_build_tiles` available to the FastAPI
process on every supported profile (mac arm64, linux x86_64, linux
arm64 aka Pi) without ever running `apt` / `brew` / `choco`. Binaries
are downloaded from pinned URLs (our own GitHub Release assets on the
`loki-doki` repo, mirroring the upstream builds), extracted under
`data/tools/<tool>/`, sha256-verified, and prepended to `PATH` the
same way `llama-cli` is today. Running `./run.sh` on a clean checkout
ends with both binaries callable.

Every other chunk depends on this one. Do not start chunk 2 until
this verifies green on at least one profile (mac is enough).

## Files

- `lokidoki/bootstrap/versions.py` — add `TIPPECANOE` and `VALHALLA_TOOLS` pinned-spec entries (URL template + per-(os,arch) artifact filename + sha256).
- `lokidoki/bootstrap/preflight/tippecanoe.py` — new preflight module (download, extract, sha-verify, put on PATH, `--version` smoke check).
- `lokidoki/bootstrap/preflight/valhalla_tools.py` — new preflight module, same shape.
- `lokidoki/bootstrap/steps.py` — register both preflights in the step list; gate behind a `maps` opt-in so profiles that never touch maps don't pay the download.
- `lokidoki/core/platform.py` — if a `MAPS_ENABLED` toggle lives here, flip its default to True; otherwise leave.
- `tests/unit/bootstrap/test_preflight_tippecanoe.py` — new; mocks the download, asserts extraction + PATH patch.
- `tests/unit/bootstrap/test_preflight_valhalla.py` — new; same shape.
- `tests/unit/bootstrap/test_versions.py` — add assertions for the two new entries.

Read-only for reference: [lokidoki/bootstrap/preflight/llama_cpp_runtime.py](../../../lokidoki/bootstrap/preflight/llama_cpp_runtime.py) and [preflight/node_runtime.py](../../../lokidoki/bootstrap/preflight/node_runtime.py) — preflight template.

## Actions

1. Decide on the artifact source. Preferred: publish per-(os,arch) tarballs as a GitHub Release on the `loki-doki` repo, e.g. `https://github.com/<owner>/loki-doki/releases/download/maps-tools-v1/tippecanoe-darwin-arm64.tar.gz`. Tag `maps-tools-v1` owns these binaries; the release is cut once and pinned forever (same as llama.cpp pattern).
2. Produce the binaries on a build host (out of scope for this chunk — document the recipe in the commit body, but the verify step only requires that the pinned URLs resolve to valid archives with matching sha256).
3. Add pinned specs in `versions.py` keyed by `(os, arch)` tuples, following the existing llama_cpp shape: `artifacts: {("darwin", "arm64"): ("tippecanoe-darwin-arm64.tar.gz", "<sha256>"), ...}`. Include all four keys: `("darwin","arm64")`, `("linux","x86_64")`, `("linux","aarch64")`, and `("windows","x86_64")` if achievable (tippecanoe on Windows is flaky — mark as `None` if not supported and have the preflight skip with a clear message).
4. Each preflight module: downloads + verifies, extracts under `data/tools/<tool>/`, flattens wrapper dirs the same way `node_runtime._flatten()` does, runs `<binary> --version` to smoke-test, patches `PATH` via `lokidoki.bootstrap.env` (or equivalent helper — match the existing pattern).
5. Wire into `steps.py` after the Node step. Gate on a new `maps_enabled` profile flag so `pi_hailo` / server-only profiles can opt out.
6. Tests: mock `urllib` / `httpx` downloads with a tarball fixture, mock `subprocess.run('--version')`, assert `data/tools/tippecanoe/bin/tippecanoe` exists and was added to `PATH`. Follow the shape of `tests/unit/bootstrap/test_preflight_node.py`.

## Verify

```bash
pytest tests/unit/bootstrap/test_preflight_tippecanoe.py \
       tests/unit/bootstrap/test_preflight_valhalla.py \
       tests/unit/bootstrap/test_versions.py -x
./run.sh --maps-tools-only    # add as an argparse flag to bootstrap/__main__.py
tippecanoe --version && valhalla_build_tiles --version
```

If `./run.sh` doesn't expose a flag for "preflight maps tools only",
add one in this chunk — the bootstrap pipeline already has the
per-step gating plumbing.

## Commit message

```
feat(bootstrap): pin tippecanoe + valhalla tools per profile

Fetches prebuilt tippecanoe and valhalla_build_tiles binaries from
the maps-tools-v1 GitHub Release and installs them under data/tools/
for every supported profile. PATH is patched via the same hook
llama-cli uses today.

No apt/brew/choco — every profile installs from the pinned URL and
sha256. mac arm64 + linux arm64 (Pi) + linux x86_64 are first-class;
Windows skips with a clear message if a Windows tippecanoe build
isn't available at release time.

Tests mock the download pipeline and assert the resulting binaries
land on PATH.

Refs docs/roadmap/maps-local-build/PLAN.md chunk 1.
```

## Deferrals section (append as you discover)

- **Windows tippecanoe support** — if upstream doesn't ship a
  reliable Windows build by chunk-1 execution, skip the Windows key
  in `versions.py` and file a follow-up. Windows maps install stays
  blocked until this clears; the preflight shows the message.
  *Status at chunk-1 landing:* the Windows entry is explicitly
  pinned to `None` in both `TIPPECANOE` and `VALHALLA_TOOLS`;
  preflights log "explicitly unsupported on (windows, x86_64)" and
  return.
- **Auto-upgrade path** — this chunk pins `maps-tools-v1` forever.
  Bumping to `v2` is a follow-up (follow llama.cpp's precedent).
- **Real binary publication** — the `maps-tools-v1` GitHub Release
  assets don't yet exist. URLs + SHAs are pinned as `0*64` stubs
  so the format guards in `test_versions.py` pass; actual archive
  publication is an out-of-band build-host task. Until then
  `./run.sh --maps-tools-only` succeeds for profiles whose key is
  `None` (skips cleanly) and fails with a sha/URL error on any
  real (os, arch) — intentional, since the chunk explicitly calls
  binary production out of scope.
- **Docker fallback removal** — chunk 1 also removed the
  `VALHALLA_DOCKER_FALLBACK` constant from `versions.py` and the
  Docker spawn path in `lokidoki/maps/routing/valhalla.py`. LokiDoki
  does not depend on Docker on any profile, so the fallback was
  obsolete the moment we pinned real native binaries. Strictly this
  was outside the files list, but deleting the constant without
  updating the single caller would have broken import at HEAD, so
  the pair ships together. Chunk 6 (lazy Valhalla sidecar) is
  unaffected — the lifecycle work stays pending there.
