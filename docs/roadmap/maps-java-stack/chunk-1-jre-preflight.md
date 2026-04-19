# Chunk 1 — Adoptium Temurin JRE preflight

## Goal

After this chunk, `./run.sh --maps-tools-only` downloads the pinned
Temurin JRE to `data/tools/jre/` on mac arm64, linux x64, linux arm64,
and windows x64, patches it onto `PATH`, and a `java -version` smoke
test returns a string. Every other chunk depends on the JRE being
reachable via `ctx.binary_path("java")`. Nothing about planetiler or
GraphHopper lands here — this chunk is the runtime foundation.

The `_MAPS_ENABLED_PROFILES` gate in `steps.py` stays empty for this
chunk; chunk 4 flips it on. The JRE preflight is wired into the
`--maps-tools-only` entry point so it's verifiable standalone without
re-enabling the broken tippecanoe / Valhalla preflights.

## Files

- `lokidoki/bootstrap/versions.py` — add `TEMURIN_JRE` spec: pinned
  version, per-`(os, arch)` artifact filename, sha256, url template
  against `api.adoptium.net/v3/binary/version/<release>/<os>/<arch>/jre/hotspot/normal/eclipse`.
  Cover all four keys: `("darwin", "arm64")`, `("linux", "x86_64")`,
  `("linux", "aarch64")`, `("windows", "x86_64")`. Delete the
  obsolete `TIPPECANOE` + `VALHALLA_TOOLS` entries now — nothing in
  `build_steps()` references them as of commit `0360f99` and later
  chunks replace the preflights wholesale.
- `lokidoki/bootstrap/preflight/temurin_jre.py` — new. Downloads the
  tarball (unix) / zip (windows), extracts into `data/tools/jre/`,
  flattens the wrapper dir Adoptium ships (`jdk-21.0.5+11-jre/...`),
  runs `java -version` as smoke test, registers `tools/jre` in
  `ctx.tools`. Follow the shape of
  [preflight/node_runtime.py](../../../lokidoki/bootstrap/preflight/node_runtime.py).
- `lokidoki/bootstrap/context.py` — add `"jre"` to `_LAYOUT` with
  `{"unix": "jre/bin/java", "win": "jre/bin/java.exe"}` so
  `ctx.binary_path("java")` is the one call every later chunk uses.
- `lokidoki/bootstrap/steps.py` — delete the `install-tippecanoe` +
  `install-valhalla-tools` entries from `_REAL_RUNNERS` and
  `_STEP_CATEGORY`; delete the `_PRE_MAPS_TOOLS` list and the
  `build_maps_tools_only_steps` body; rebuild the maps-tools-only
  step list to return `[detect-profile, install-jre]` only. Register
  `install-jre` in `_REAL_RUNNERS` / `_STEP_CATEGORY` (category
  `"system"`). **Do NOT** re-add anything to `_MAPS_ENABLED_PROFILES`
  yet — that's chunk 4.
- `lokidoki/bootstrap/preflight/__init__.py` — export
  `ensure_temurin_jre` alongside the other `ensure_*` funcs if the
  module uses a public-surface pattern.
- `lokidoki/bootstrap/preflight/tippecanoe.py` — **delete**.
- `lokidoki/bootstrap/preflight/valhalla_tools.py` — **delete**.
- `tests/unit/bootstrap/test_preflight_tippecanoe.py` — **delete**.
- `tests/unit/bootstrap/test_preflight_valhalla.py` — **delete**.
- `tests/unit/bootstrap/test_preflight_temurin_jre.py` — new. Mock
  the download with a tarball fixture, mock `subprocess.run('java -version')`,
  assert `data/tools/jre/bin/java` exists and the bin dir landed on
  `PATH` for all four `(os, arch)` keys.
- `tests/unit/bootstrap/test_versions.py` — drop the tippecanoe +
  valhalla assertions, add JRE assertions (URL shape, four keys,
  sha256 length).

Read-only for reference:
[lokidoki/bootstrap/preflight/node_runtime.py](../../../lokidoki/bootstrap/preflight/node_runtime.py),
[lokidoki/bootstrap/preflight/llama_cpp_runtime.py](../../../lokidoki/bootstrap/preflight/llama_cpp_runtime.py),
[lokidoki/bootstrap/versions.py](../../../lokidoki/bootstrap/versions.py)
(existing llama.cpp shape — mirror it for the JRE).

## Actions

1. Resolve the Adoptium download URLs. The API template is
   `https://api.adoptium.net/v3/binary/version/jdk-<VERSION>/<os>/<arch>/jre/hotspot/normal/eclipse`
   and it 302s to `github.com/adoptium/temurin21-binaries/releases/download/...`.
   Either pin the redirect target (preferred — matches the llama.cpp
   pattern of pinning the actual GH release asset URL) or whitelist
   the Adoptium API host in `context.download()`. Pinned target is
   cleaner; follow it.
2. Download each platform's JRE locally **once** to capture the
   sha256 and the exact asset filename. Record in `versions.py`:
   ```python
   TEMURIN_JRE = {
       "version": "21.0.5+11",
       "artifacts": {
           ("darwin", "arm64"): ("OpenJDK21U-jre_aarch64_mac_hotspot_21.0.5_11.tar.gz", "<sha256>"),
           ("linux", "x86_64"): ("OpenJDK21U-jre_x64_linux_hotspot_21.0.5_11.tar.gz", "<sha256>"),
           ("linux", "aarch64"): ("OpenJDK21U-jre_aarch64_linux_hotspot_21.0.5_11.tar.gz", "<sha256>"),
           ("windows", "x86_64"): ("OpenJDK21U-jre_x64_windows_hotspot_21.0.5_11.zip", "<sha256>"),
       },
       "url_template": (
           "https://github.com/adoptium/temurin21-binaries/releases/download/"
           "jdk-{version}/{filename}"
       ),
   }
   ```
   Version string must be URL-safe (the `+` in the build number
   becomes `%2B` in the path — use `urllib.parse.quote` in the
   preflight rather than baking it into `version`).
3. `preflight/temurin_jre.py`: async `ensure_temurin_jre(ctx)` that:
   - resolves `(os, arch)` → spec via `os_arch_key` helper,
   - downloads with sha256 verification using `ctx.download`,
   - extracts tar.gz (unix) or zip (windows) into
     `data/tools/jre/`, flattening the single top-level
     `jdk-*-jre/` dir,
   - chmods `bin/java` on unix (and every file in `bin/` — Adoptium
     ships many),
   - runs `ctx.binary_path("java") -version` with a 10-second
     timeout; logs the output (version string goes to stderr on
     java, which `_smoke_ok` should capture),
   - registers `"jre"` in `ctx.tools` so `augmented_env()` prepends
     `data/tools/jre/bin` to `PATH`.
4. Wire `install-jre` into the pipeline:
   - Add to `_REAL_RUNNERS`.
   - Add to `_STEP_CATEGORY` as `"system"`.
   - `build_maps_tools_only_steps()` returns
     `[detect-profile, install-jre]`. `build_steps()` stays
     unchanged (no maps profile is enabled yet).
5. Delete the tippecanoe + valhalla preflight modules, their tests,
   and their entries in `_REAL_RUNNERS` / `_STEP_CATEGORY`. Keep the
   rest of `steps.py` intact.
6. Tests: mirror
   `tests/unit/bootstrap/test_preflight_node.py` — tarball fixture,
   mocked `httpx` / `urllib`, assert resulting layout + PATH patch
   for all four `(os, arch)` keys (parametrise). Include one test
   that asserts the windows `.zip` path (use `zipfile.ZipFile` in
   the fixture, not `tarfile`). Update `test_versions.py`.

## Verify

```bash
uv run pytest tests/unit/bootstrap/test_preflight_temurin_jre.py \
              tests/unit/bootstrap/test_versions.py \
              tests/unit/bootstrap/test_hailo_fallback.py -x -q

# End-to-end with a live network fetch (mac only — skip on CI).
rm -rf .lokidoki/tools/jre .lokidoki/cache
./run.sh --maps-tools-only
.lokidoki/tools/jre/bin/java -version
```

`java -version` must print something like
`openjdk version "21.0.5" 2024-10-15 LTS` on success.

## Commit message

```
feat(bootstrap): pin Adoptium Temurin JRE 21 preflight

Replaces the broken tippecanoe + Valhalla maps-tools preflights with
a single Adoptium Temurin JRE 21 preflight. JRE lands under
data/tools/jre/ and ctx.binary_path("java") is the call every later
chunk uses. Mac arm64, linux x64/arm64, and Windows x64 are
first-class — all four pulled from Adoptium's own GitHub Release
assets, no third-party hosting by us.

--maps-tools-only now runs [detect-profile, install-jre] and nothing
else; profile-level maps enablement stays off until chunk 4 lands.

Refs docs/roadmap/maps-java-stack/PLAN.md chunk 1.
```

## Deferrals section (append as you discover)

*(empty — leave for chunk-1 execution to fill)*
