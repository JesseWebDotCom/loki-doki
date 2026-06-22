---
title: Maps
description: Offline maps with MapLibre, pmtiles, GraphHopper routing, and FTS geocoder.
sidebar:
  order: 6
---

## Overview

Offline maps using vector tiles, no tile API key required. The full planet (or a regional extract) is stored locally and rendered client-side via MapLibre GL.

---

## Stack

| Component | Role |
|---|---|
| MapLibre GL JS | Client-side vector tile rendering |
| pmtiles | Single-file vector tile archive format |
| planetiler | Generates pmtiles from OpenStreetMap data |
| GraphHopper | Offline routing (walking, driving, cycling) |
| FTS geocoder | SQLite full-text search geocoder (custom) |
| `osmium` | Preprocessing tool for building the search index |

---

## Map Regions

Regions are managed in the `map_regions` DB table. Each region has:
- A name and bounding box
- A pmtiles file path
- A GraphHopper graph data path

Admin → Maps tab (AdminMapsTab) handles region import and status.

---

## Routing

GraphHopper provides turn-by-turn routing. The backend proxies GraphHopper requests at `/api/maps/route`. Routing profiles: walking, driving, cycling.

---

## Geocoder

The FTS geocoder uses SQLite's built-in `fts5` extension to index place names from OpenStreetMap. Search queries go to `/api/maps/search`. `osmium` is required to build the search index from OSM data.

---

## Adding a Region

1. Download an OSM extract (`.osm.pbf`) for the region
2. Run planetiler to generate the pmtiles file
3. Run GraphHopper to build the routing graph
4. Build the FTS geocoder index via `osmium`
5. Add the region in Admin → Maps

The Admin UI automates steps 2–4 when given a `.osm.pbf` source.
