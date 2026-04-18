# Offline Maps — Execution Plan

Goal: a user with zero internet can open `/maps`, see a vector basemap (optionally with satellite imagery), search for an address, drop a pin, get driving/walking/cycling directions with spoken turn-by-turn, and browse it all through an Apple Maps–style UI (left rail with Search / Guides / Directions / Recents, place-details cards, route alternatives with ETA badges). Regions are picked explicitly — no 100 GB surprise download.

Today the `/maps` page needs the internet for OSM raster tiles (rendering), Nominatim (geocoding), and remote OSRM (routing). This plan swaps each to a local, per-region artifact and wraps it in a first-class UI.

---

## How to use this document (Claude Code operating contract)

You are a fresh Claude Code session. You have been pointed at this file and given no other instructions.

**Do exactly this:**

1. Read the **Status** table below. Pick the **first** chunk whose status is `pending` — call it Chunk N.
2. Open `chunk-N-*.md` and read it completely. **Do not open any other chunk doc.**
3. Execute every step in its `## Actions` section.
4. Run the command in its `## Verify` section. If it fails, do not proceed — diagnose or record the block and stop. Do not fake success.
5. If verify passes:
   - Stage only the files the chunk touched.
   - Commit using the template in the chunk's `## Commit message` section. Follow `memory/feedback_no_push_without_explicit_ask.md` — **commit only; do not push, open a PR, or merge.**
   - Edit this `PLAN.md`: flip the chunk's row from `pending` to `done` and paste the commit SHA in the `Commit` column.
   - If during execution you discovered work that had to be pushed to a later chunk, append a `## Deferred from Chunk N` bullet list to that later chunk's doc with the specifics.
6. **Stop.** Do not begin the next chunk in the same session. Each chunk gets its own fresh context to keep token use minimal.

**If blocked** (verify keeps failing, required file is missing, intent of the chunk is unclear): leave the chunk status as `pending`, write a `## Blocker` section at the bottom of that chunk's doc explaining what's wrong, and stop. Do not guess.

**Scope rule**: only touch files listed in the chunk doc's `## Files` section. If work sprawls beyond that list, stop and defer the sprawl to a later chunk rather than expanding this one.

---

## Status

| # | Chunk                                                                             | Status  | Commit |
|---|-----------------------------------------------------------------------------------|---------|--------|
| 1 | [PMTiles infrastructure + protocol wiring](chunk-1-pmtiles-infra.md)              | done    | 1bd5119 |
| 2 | [Map region catalog + admin panel + download pipeline](chunk-2-region-picker.md)  | done    | aa9f29c |
| 3 | [Frontend tile rendering — vector + satellite + hybrid toggle](chunk-3-tile-rendering.md) | done    | 25fb564 |
| 4 | [Apple Maps-style left rail + place-details card](chunk-4-apple-maps-ui.md)       | done    | 3492a8a |
| 5 | [Offline geocoding — FTS5 address index per region](chunk-5-offline-geocoding.md) | done    | 61fbe70 |
| 6 | [Offline routing backend — Valhalla sidecar per region](chunk-6-routing-backend.md) | pending |        |
| 7 | [Directions panel UI + route alternatives + turn-by-turn](chunk-7-directions-ui.md) | pending |        |

---

## Global context (read once, applies to every chunk)

### What exists today (read-only)

- **Frontend maps page**: [frontend/src/pages/MapsPage.tsx](../../../frontend/src/pages/MapsPage.tsx) — MapLibre GL 5.23 is already installed; today it points at `https://tile.openstreetmap.org/{z}/{x}/{y}.png` and Nominatim for search. Dark Onyx theme CSS is injected at module level.
- **Navigation skill**: [lokidoki/orchestrator/skills/navigation.py](../../../lokidoki/orchestrator/skills/navigation.py) — `get_directions()` hits remote OSRM; `get_eta()` derives from it; `find_nearby()` hits Overpass. All three are online-only today.
- **Archive system (reuse as template)**: the ZIM admin panel at [frontend/src/components/settings/ArchivesSection.tsx](../../../frontend/src/components/settings/ArchivesSection.tsx), catalog at [lokidoki/archives/catalog.py](../../../lokidoki/archives/catalog.py), models at [lokidoki/archives/models.py](../../../lokidoki/archives/models.py), store under `data/archives/zim/`. The new map-region picker mirrors this shape — same pattern, different artifact type.
- **No backend maps router yet**. Chunks 2/5/6 add `lokidoki/api/routes/maps.py` and `lokidoki/maps/` as a new subsystem.

### Target on-disk layout

```
data/maps/
  <region_id>/                  # e.g. "us-ct"
    streets.pmtiles             # vector basemap (Chunk 2)
    satellite/                  # raster satellite tarball extracted (Chunk 2, optional)
    geocoder.sqlite             # FTS5 address index (Chunk 5)
    valhalla/                   # routing tiles (Chunk 6)
  catalog.json                  # installed regions + their artifacts
```

Everything under `data/maps/` is gitignored (same rule as `data/archives/`). A single `rm -rf data/maps/<region_id>/` cleanly uninstalls a region.

### Tech choices (decided — do not re-litigate per chunk)

- **Vector tiles**: Protomaps basemap schema delivered as a single `.pmtiles` file per region, served by MapLibre through the `pmtiles://` protocol. No tileserver process.
- **Satellite tiles**: raster tile bundles from Esri World Imagery (terms-compatible) or a comparable source, served as static files. Opt-in, off by default.
- **Geocoder**: SQLite FTS5 over `addr:*` and `place=*` features extracted from the Geofabrik `.osm.pbf` at install time. Single process, no Java/Rust sidecar. Photon/Pelias explicitly deferred — see Chunk 5.
- **Router**: **Valhalla**, but **tiles are always downloaded pre-built per region** — never computed on-device. The routing engine itself is a tiny runtime (serves tiles via HTTP); tile building from a `.osm.pbf` is a separate offline pipeline that runs on a beefy build host and publishes a `.tar.zst` next to the PMTiles. Picked over OSRM/GraphHopper because (a) tiled storage runs country-scale graphs on <8 GB RAM at **serve time** — critical for Pi 5, (b) auto/pedestrian/bicycle all come from the same tile set, (c) built-in localized turn-by-turn narrative — no `osrm-text-instructions` bolt-on.
- **UI framing**: Apple Maps–like. Left rail with Search / Guides / Directions / Recents (see the reference screenshots in `docs/roadmap/README.md`). Place-details cards with a prominent blue Directions button. Directions panel with car/walk/bike mode toggle, reorderable From/To, "Add Stop", "Now"/"Avoid" dropdowns, and a scrollable alternatives list whose badges also appear on the map route line.

### Pi 5 constraints (load-bearing — violate and the plan silently breaks)

LokiDoki's primary deployment target is a **Raspberry Pi 5 (8 GB, aarch64, Debian bookworm)**. Everything in this plan must work within these limits:

- **RAM ceiling: 8 GB**, shared with the LLM, vision, TTS, and the FastAPI app. Any subsystem that peaks over **~2 GB RSS** during normal operation is a non-starter.
- **No on-device tile builds for country-scale regions.** `valhalla_build_tiles` on a US contig `.osm.pbf` needs ~16 GB RAM — the Pi OOMs. State-scale builds (CT, CA) fit in ~2–6 GB and are fine. Chunk 6 therefore **downloads prebuilt Valhalla tiles as a region artifact** by default; local tile build is a dev-only escape hatch guarded by a config flag, and the region catalog only allows local build for regions whose `pbf_size_mb < 500`.
- **No on-device FTS5 build for country-scale regions on first install.** A full US FTS build takes ~1 h and ~3 GB RAM on Pi 5; acceptable as a background task but user sees progress and may power-cycle mid-build. Chunk 5's store must resume cleanly.
- **No `apt` / `brew` / `choco`** per AGENTS.md. The Valhalla runtime arrives as either (a) a prebuilt arm64 tarball mirrored on our CDN (preferred) or (b) a multi-arch Docker image (`ghcr.io/gis-ops/docker-valhalla` or similar community fork with arm64 layers — pin the digest in `versions.py`). Docker is optional, not required. Chunk 6 implements both paths.
- **SD-card I/O is slow.** `.pmtiles` reads benefit from MapLibre's byte-range caching; Valhalla's mmap'd tile access is SSD-friendly but fine on SD for one-user loads. Avoid synchronous wholesale reads.
- **No GPU for rendering.** MapLibre GL runs entirely in the browser's WebGL context on whatever client connects; the Pi itself does not render tiles.
- **Hailo NPU is off-limits for maps.** Per AGENTS.md:52, Hailo accelerates LLM + vision only. Routing, geocoding, and tile serving are CPU-only on every profile, always.

### Per-region footprint (authoritative — update Chunk 2's size table if changed)

| Region           | PMTiles | Satellite | Geocoder (FTS5) | Valhalla tiles | Peak build RAM | Pi 5 local build? |
|------------------|--------:|----------:|----------------:|---------------:|---------------:|:-----------------:|
| Small state (CT) | ~80 MB  | ~8 GB     | ~40 MB          | ~40 MB         | ~2 GB          | yes               |
| Large state (CA) | ~400 MB | ~40 GB    | ~200 MB         | ~250 MB        | ~4 GB          | yes (slow)        |
| UK               | ~500 MB | ~60 GB    | ~300 MB         | ~400 MB        | ~6 GB          | no — download prebuilt |
| US (contig.)     | ~2 GB   | ~400 GB   | ~1.5 GB         | ~14 GB         | ~16 GB         | no — download prebuilt |

Valhalla routing adds roughly 0.5× the PMTiles size at state level and ~7× at country level (road graph is denser per byte than rendered tiles at continental scale). The `Pi 5 local build?` column gates whether Chunk 6 attempts a local `valhalla_build_tiles` run; for "no" rows, the region catalog's `valhalla_url_template` is the only install path.

### Hard rules for this plan

- **Perfectly offline once a region is installed.** With a region installed that covers where the user is looking, the Maps page must behave identically whether the Pi has internet or not: tiles render, search returns results, routes compute, turn-by-turn speaks. **Network is only touched when there is no installed region that covers the current viewport.** Never make a network request that the user can perceive (spinner, latency, failed fetch) inside a covered area — that's the whole product.
- **Internet is only required at setup time** — downloading the initial region. After that, a Pi disconnected from the internet forever is a first-class supported mode. The only exception is panning to an area the user never installed, in which case Chunk 3's OutOfCoverageBanner surfaces rather than a broken map.
- **No silent 100 GB downloads.** Every region install shows combined size in a footer pill and requires an explicit click.
- **One source of truth per artifact type.** PMTiles under `data/maps/<region>/streets.pmtiles`; no second "downloads" dir.
- **Satellite is always opt-in and off by default.** Its size warning on the admin tab is load-bearing UX.
- **No browser dialogs.** Confirmations go through `ConfirmDialog.tsx` per `AGENTS.md:144`. The region picker's "replace selection" / "abort download" prompts use the shared modal, never `window.confirm`.
- **Every online-assist path must degrade gracefully offline.** The region picker's "My region" / "My country" presets use Nominatim reverse-geocode when online; offline, they fall back to a manual country/state dropdown. The Nominatim search fallback from Chunk 5 simply does not fire offline — the empty-state message is the UX, not a hung spinner.

---

## Non-goals (for this plan — may land later)

- Turn-by-turn **voice** nav with live rerouting on GPS. Chunk 7 ships the narrative text and wires it into the existing TTS path for a one-shot readout; full navigation mode is a later roadmap item.
- Live traffic. Requires network by definition.
- Custom user-uploaded bounding-box downloads. v1 catalog-only; side-loading a `.pmtiles` still works.
- Photon/Pelias full geocoders. FTS5 ships first; swap in if users hit fuzzy-match gaps (Chunk 5 deferral).
- 3D buildings / terrain shading. Protomaps schema supports it; not in this plan.

---

## NOTE (append as chunks land)

*(empty — chunks add cross-chunk notes or deferrals here)*
