# Offline Maps — chunked plan

Today the Maps page needs an internet connection for both the map
imagery (OpenStreetMap public raster tiles) and address search
(Nominatim public API). The goal is to let a user download a region
they care about — their state, country, or a custom bounding box —
and have the map + address search + road directions work without any
network.

This is deliberately scoped in independently-shippable chunks so we
don't hide a multi-week feature behind one "offline maps" PR.

---

## Chunk 1 — PMTiles infrastructure (no user-visible feature yet)

**Goal**: MapLibre can render from a local `.pmtiles` file when one is
present. Still online-first — this just wires up the plumbing.

**Work**:
- Add the `pmtiles` npm package.
- Register the `pmtiles://` protocol with MapLibre at app startup.
- Create a new map style JSON based on the Protomaps basemap schema
  (vector tiles instead of raster). Start with one theme (dark) that
  matches the Onyx Material palette.
- `MapsPage` checks for `/api/v1/maps/tiles/<region_id>` before falling
  back to the online OSM style — but since no region is installed yet,
  the user sees exactly the same behavior as today.

**Ship criteria**: no visible change for users; PMTiles protocol works
against a dev-local test file.

**Estimated size**: 1 day.

---

## Chunk 2 — Region-picker admin panel (not "download one file")

**Goal**: The map archive is NOT a monolithic Wikipedia-style
download. Users pick which regions they want for streets, pick a
(possibly smaller) subset for satellite, watch the size update live,
and commit with one button. Downloading "the map" without choosing
regions is a trap — users would unknowingly fetch 100 GB.

### Data model

The catalog gains a new `MapArchive` type distinct from `ZimSource`:

```python
@dataclass(frozen=True)
class MapRegion:
    region_id: str                  # "us", "us-ca", "ca-canada", "mx"
    label: str                      # "United States", "California", "Canada"
    parent_id: str | None           # "us" for "us-ca"; None for top-level
    center_lat: float               # for the zoom-to-preview map
    center_lon: float
    street_size_mb: float           # street-map (PMTiles) bytes
    satellite_size_mb: float        # add-on satellite imagery bytes
    street_url_template: str        # Protomaps/daylight URL pattern
    satellite_url_template: str     # Esri or similar
```

Stored state (per-user config, SQLite):

```python
MapArchiveConfig:
    street_regions: list[str]       # ["us-ct", "us-ny"]
    satellite_regions: list[str]    # ["us-ct"]  — subset (or disjoint!) of streets
    storage_path: str | None
```

Street and satellite selections are **independent**. You can have
satellite for Connecticut (80 MB street + 8 GB sat) and just streets
for California (400 MB) in the same archive. Total size = sum of
`street_size_mb` over selected street regions + sum of
`satellite_size_mb` over selected satellite regions.

### Seed catalog (starter regions)

Tree-structured so the UI can nest: continents → countries →
first-level subdivisions.

| Region                      | Street | Satellite | Parent |
|-----------------------------|-------:|----------:|:-------|
| North America               | —      | —         | —      |
|  United States (contig.)    | ~2 GB  | ~400 GB   | NA     |
|   California                | ~400 MB| ~40 GB    | US     |
|   New York                  | ~300 MB| ~28 GB    | US     |
|   Connecticut               | ~80 MB | ~8 GB     | US     |
|   Texas                     | ~500 MB| ~55 GB    | US     |
|   (~50 US states)           | …      | …         | US     |
|  Canada                     | ~2.5 GB| ~500 GB   | NA     |
|  Mexico                     | ~1.5 GB| ~300 GB   | NA     |
| Europe                      | —      | —         | —      |
|  United Kingdom             | ~500 MB| ~60 GB    | EU     |
|  Germany, France, Italy…    | …      | …         | EU     |
| Asia                        | —      | —         | —      |
|  Japan                      | ~1 GB  | ~100 GB   | AS     |

(Satellite sizes are rough — real numbers come from the provider.)

### Admin panel UX

Clicking "Knowledge Archives → Maps" opens a different panel from the
ZIM detail modal. Two tabs:

**Tab 1 — Street maps** (the default, "always free-ish"):

- Tree-view of regions with checkboxes. Parents show aggregate size
  (uncheckable — a convenience for "pick all children").
- Per-row: region name · street size · checkbox.
- Running total pill at the bottom: `Street maps: 480 MB (2 regions)`.
- Preset buttons above the tree: "My state" (auto-detect), "My country",
  "North America (US + CA + MX)", "Clear all".

**Tab 2 — Satellite imagery** (opt-in, scary sizes):

- Same tree, same checkboxes — but a **separate selection set**.
- Each row has a clear size-warning when size > 5 GB.
- A bold warning banner above: "Satellite imagery is 10–20× larger than
  street maps. Pick only the regions you actually need photography
  for."
- Greyed-out rows for regions not included in the street selection —
  you can't have satellite-without-street (forces users to understand
  they're adding on top of, not instead of).

**Footer** (always visible):

```
Street maps: 480 MB · Satellite: 8 GB · Total: 8.5 GB
              [Install / Update]
```

Install button runs a multi-file download: one PMTiles per street
region + one raster bundle per satellite region. Progress bar shows
file count and bytes. Cancel works mid-download and rolls back partial
files.

### Presets

The biggest UX win over the ZIM flow. Three buttons that auto-select
sensible regions:

- **"My region"** — detects user's state/province from IP or
  navigator.geolocation (fall back to prompt). Selects that admin unit
  + surrounding states at street resolution.
- **"My country"** — auto-selects the user's country.
- **"North America"** — US + Canada + Mexico street-only.

All three still show the size and require a click to install — no
silent downloads.

**Ship criteria**: a user unfamiliar with tile formats can pick
"Connecticut street + satellite, California street only" from the
admin panel, watch a single combined progress bar, and end up with
the four correct files on disk.

**Estimated size**: 3-4 days (was 2-3; the region-picker UI is the
bulk of the extra time).

---

## Chunk 3 — Frontend wiring for installed regions + satellite toggle

**Goal**: When the user opens `/maps` and has regions installed,
MapLibre uses local PMTiles for street and local raster tiles for
satellite. Falls back to online only when the view is outside every
installed region.

**Work**:
- Frontend polls `/api/v1/maps/regions` on mount; merges all installed
  street bounding-boxes into a single offline-coverage polygon and
  satellite bounding-boxes into a second polygon.
- `MapsPage` style has three display modes:
  - **Map** (streets only) — vector PMTiles when in-coverage, online OSM
    when out-of-coverage.
  - **Satellite** — raster satellite when in-coverage; a muted tint
    with "No satellite for this area — install it in the admin panel"
    when outside.
  - **Hybrid** — satellite underneath + streets labels on top.
- Top-right chip (under the zoom controls): `Map · Satellite · Hybrid`
  toggle, matching Google Maps.
- When user pans outside every installed region while offline: soft
  grey tint + small pill "No tiles here — install a larger region".

**Ship criteria**: toggling regions on/off in the admin panel
immediately reshapes the offline-coverage polygon in the Maps page.
Satellite mode is greyed out when zero satellite regions are
installed.

**Estimated size**: 2-3 days.

---

## Chunk 4 — Offline address search

**Goal**: Address/city/ZIP search works without Nominatim.

**Options** (pick one, not all):
- **4a — Bundled address index per region (preferred)**. Extract a
  searchable index from the downloaded OSM PBF. Ship a small Rust/Go
  geocoder like [Pelias](https://github.com/pelias/pelias) or
  [Photon](https://github.com/komoot/photon) as a sidecar process
  driven by the Python API. Per-region index sizes: US 5-8 GB, CA 400
  MB, state-level 50-300 MB.
- **4b — Simpler FTS-only index**. Extract `addr:*` + `place=*` nodes
  from the PBF into SQLite FTS5 at download time. Loses typo tolerance
  and "near me" biasing, but stays in-process and adds ~200 MB per
  region. Good enough for ZIP/city lookup; weak for full addresses.

Recommendation: **start with 4b** for the first ship (one process, no
Java/Rust sidecar), upgrade to 4a if users hit typo or fuzzy-match
gaps.

**Ship criteria**: with internet off, typing a query still returns
address results when at least one region is installed.

**Estimated size**: 4b ~3 days, 4a ~1 week.

---

## Chunk 5 — Routing / directions (stretch)

**Goal**: "How long to drive to San Francisco" works offline.

**Work**: Bundle [OSRM](http://project-osrm.org/) or
[Valhalla](https://github.com/valhalla/valhalla) as a sidecar against
the same PBF extract. Most users don't need this day-one.

**Ship criteria**: `get_eta` + `get_directions` skills route offline
against the installed region.

**Estimated size**: 1 week.

---

## Size overview (install footprint by region)

Sum street + optional satellite + optional address index. These
are the numbers the footer pill in the region picker is showing.

| Region                    | Street   | Satellite | Addresses (FTS) | Addresses (Photon) |
|---------------------------|---------:|----------:|----------------:|-------------------:|
| Small state (CT)          | ~80 MB   | ~8 GB     | ~40 MB          | ~120 MB            |
| Large state (CA)          | ~400 MB  | ~40 GB    | ~200 MB         | ~600 MB            |
| United Kingdom            | ~500 MB  | ~60 GB    | ~300 MB         | ~800 MB            |
| United States (contig.)   | ~2 GB    | ~400 GB   | ~1.5 GB         | ~6 GB              |
| Whole world               | ~100 GB  | ~60–150 TB| ~60 GB          | ~200 GB            |

Defaults the first-install flow should steer toward:

- **Preset "My state"** — single-state street + FTS address index.
  Typically under 500 MB.
- **Preset "My country"** — country-level street + FTS addresses.
  Under 3 GB for most countries.
- Satellite is always **opt-in, off by default** — the size warning
  on the satellite tab makes it clear that checking a state adds a
  whole other order of magnitude.

---

## Non-goals for v1

- Satellite/aerial imagery — too big (tens of GB per region) and
  separate tileset pipeline. Streets-only is enough.
- Turn-by-turn navigation — Chunk 5 only provides ETA/route geometry.
  Voice-guided navigation is a Phase-later feature.
- Live traffic — explicitly a networked feature; always requires
  internet and is out of scope for "offline maps".
- Custom bounding-box uploads — catalog-only for v1. Advanced users can
  still side-load a PMTiles file to the install dir.
