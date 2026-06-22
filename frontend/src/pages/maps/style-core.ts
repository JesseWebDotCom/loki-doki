import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

import { boundaryLayers, landLayers } from "./style-layers-land";
import {
  placeLabelLayers,
  routeShieldLayers,
  streetLabelLayers,
  waterPoiAndHouseLayers,
} from "./style-layers-labels";
import {
  buildings2dLayer,
  buildings2dOutlineLayer,
  buildings3dLayer,
  buildingsShadowLayer,
  roadLayers,
  speedLimitLayer,
} from "./style-layers-roads";
import { constructionLayers, hazardPointLayers } from "./style-layers-hazards";
import type { Palette } from "./style-palette";
import type { LayerMode } from "./types";

export type { Palette };

// 7-color palette indexed by Natural Earth `mapcolor7` (1..7). Chosen to
// have enough chroma to read clearly against the dark map background
// (#1f2832) while still letting place labels sit on top — see
// `overview-country-fill` below for the match expression.
const COUNTRY_FILL_COLORS: readonly string[] = [
  "#3d527a", // mapcolor7=1 — navy
  "#4a6638", // 2 — forest
  "#7a3d44", // 3 — wine
  "#3d6e6a", // 4 — teal
  "#5a3d7a", // 5 — plum
  "#7a623d", // 6 — amber
  "#3d627a", // 7 — steel
];

// 9-color tints used to differentiate first-order admin units (US states,
// Canadian provinces, …) within a country. Slightly desaturated relative
// to the country palette so neighboring states look like variants of a
// region, not whole new countries.
const STATE_FILL_COLORS: readonly string[] = [
  "#4f6585", // mapcolor9=1
  "#5d7647", // 2
  "#86505a", // 3
  "#4d7e78", // 4
  "#6c4f87", // 5
  "#867150", // 6
  "#4f7187", // 7
  "#7d588f", // 8
  "#577a5a", // 9
];

export function buildMapStyle(
  palette: Palette,
  tileUrl: string | null,
  overviewUrl: string,
  labelsUrl: string,
  countriesUrl: string,
  statesUrl: string,
  opts: { mode?: LayerMode } = {},
): StyleSpecification {
  const mode = opts.mode ?? "map";
  const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  const sources: StyleSpecification["sources"] = {
    overview: { type: "vector", url: overviewUrl, maxzoom: 7, attribution: OSM_ATTRIBUTION },
    labels: { type: "geojson", data: labelsUrl },
    countries: { type: "geojson", data: countriesUrl },
    states: { type: "geojson", data: statesUrl },
  };
  if (tileUrl) {
    sources.region = { type: "vector", url: tileUrl, attribution: OSM_ATTRIBUTION };
    // Satellite-derived landcover raster (ESA WorldCover), baked per region.
    sources["landcover-raster"] = {
      type: "raster",
      url: tileUrl.replace("/streets.pmtiles", "/landcover.pmtiles"),
      tileSize: 256,
      maxzoom: 12,
    };
  }

  const layers: LayerSpecification[] = [
    { id: "background", type: "background", paint: { "background-color": palette.background } },
  ];

  // Landcover wash sits just above the background so every OSM vector — water,
  // parks, roads, buildings, labels — draws crisply on top. Colours EVERY acre
  // (forest/cropland/grass/water/wetland), filling the rural land OSM leaves
  // blank. Only present with an active region; 404s gracefully until built.
  if (tileUrl) {
    const lcO = palette.landcoverOpacity;
    layers.push({
      id: "region-landcover-raster",
      type: "raster",
      source: "landcover-raster",
      paint: {
        // Keep the naturalistic land wash through street zoom; only a gentle
        // taper at extreme close-up to soften the 10 m raster's blockiness.
        // Water is baked transparent (vector water renders it crisply), so the
        // raster only ever tints land — no coarse navy blobs to fade out.
        "raster-opacity": ["interpolate", ["linear"], ["zoom"], 5, lcO, 16, lcO, 19, lcO * 0.7],
        "raster-fade-duration": 0,
      },
    });
  }

  // Country and state context layers are always included so they provide
  // geographic reference at overview zoom even when region tiles are active.
  // Both fade out before city zoom (maxzoom / opacity interpolation) so they
  // never compete with the detailed region layers.
  layers.push(
    { id: "overview-water", type: "fill", source: "overview", "source-layer": "water", paint: { "fill-color": palette.water } },
    { id: "overview-landcover", type: "fill", source: "overview", "source-layer": "landcover", paint: { "fill-color": palette.residential, "fill-opacity": 0.45 } },
    {
      id: "overview-country-fill",
      type: "fill",
      source: "countries",
      maxzoom: 6,
      paint: {
        "fill-color": [
          "match", ["get", "mapcolor7"],
          1, COUNTRY_FILL_COLORS[0],
          2, COUNTRY_FILL_COLORS[1],
          3, COUNTRY_FILL_COLORS[2],
          4, COUNTRY_FILL_COLORS[3],
          5, COUNTRY_FILL_COLORS[4],
          6, COUNTRY_FILL_COLORS[5],
          7, COUNTRY_FILL_COLORS[6],
          COUNTRY_FILL_COLORS[0],
        ],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.95, 4, 0.85, 6, 0.0],
        "fill-antialias": true,
      },
    },
    {
      id: "overview-country-outline",
      type: "line",
      source: "countries",
      paint: {
        "line-color": "#c8d2dc",
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.8, 4, 1.4, 8, 1.8],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.9, 9, 0.55],
      },
    },
    {
      id: "overview-state-fill",
      type: "fill",
      source: "states",
      minzoom: 2,
      maxzoom: 9,
      paint: {
        "fill-color": [
          "match", ["get", "mapcolor9"],
          1, STATE_FILL_COLORS[0],
          2, STATE_FILL_COLORS[1],
          3, STATE_FILL_COLORS[2],
          4, STATE_FILL_COLORS[3],
          5, STATE_FILL_COLORS[4],
          6, STATE_FILL_COLORS[5],
          7, STATE_FILL_COLORS[6],
          8, STATE_FILL_COLORS[7],
          9, STATE_FILL_COLORS[8],
          STATE_FILL_COLORS[0],
        ],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0, 4, 0.45, 8, 0.6, 9, 0],
      },
    },
    {
      id: "overview-state-outline",
      type: "line",
      source: "states",
      minzoom: 2,
      maxzoom: 9,
      paint: {
        "line-color": "#9aa6b2",
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 5, 1.0, 8, 1.3],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 4, 0.85, 9, 0],
        "line-dasharray": [3, 2],
      },
    },
  );

  if (!tileUrl) {
    // overview-only mode: no region source; the GeoJSON context + overview
    // pmtiles above are the only data. Nothing more to add here.
  } else {
    // Draw order bottom-to-top: fills → boundaries → roads → buildings
    // → water/POI labels → street labels → route shields → place labels.
    // background sits at index 0 underneath everything.
    layers.push(
      ...landLayers(palette),
      ...boundaryLayers(palette),
      ...roadLayers(palette),
      ...constructionLayers(),
      buildingsShadowLayer(),
      ...(mode === "3d"
        ? [buildings3dLayer(palette)]
        : [buildings2dLayer(palette), buildings2dOutlineLayer(palette)]),
      ...hazardPointLayers(),
      ...waterPoiAndHouseLayers(palette),  // includes the interactive `poi-label` layer
      speedLimitLayer(),
      ...streetLabelLayers(palette),
      ...routeShieldLayers(),
      ...placeLabelLayers(palette),
    );
  }

  layers.push(
    {
      id: "overview-country",
      type: "symbol",
      source: "labels",
      filter: ["==", ["get", "kind"], "country"],
      // Keep labels off the globe view (zoom <= 3.6): moving symbols re-run
      // placement during auto-rotation and flicker. They fade in as you dive.
      minzoom: 3.7,
      maxzoom: 5,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Medium"],
        // area_log ≈ log10(degree² · cos(lat)): Antarctica/Russia ~2.7,
        // mid countries ~1.5, small states ~0.0. Scale text by that so big
        // features read at a glance and tiny ones don't crowd them.
        "text-size": [
          "interpolate", ["linear"], ["zoom"],
          0, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 1], 0, 9, 1.5, 11, 2.7, 15],
          4, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 1], 0, 11, 1.5, 14, 2.7, 20],
        ],
        "text-anchor": "center",
        "text-justify": "center",
        "text-max-width": 8,
        "symbol-placement": "point",
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": palette.placeLabel,
        "text-halo-color": palette.placeLabelHalo,
        "text-halo-width": 1,
      },
    },
    {
      id: "overview-state",
      type: "symbol",
      source: "labels",
      filter: ["==", ["get", "kind"], "state"],
      minzoom: 3.7,
      maxzoom: 9,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Medium"],
        "text-size": [
          "interpolate", ["linear"], ["zoom"],
          3, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 0], -1, 9, 1, 12],
          6, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 0], -1, 11, 1, 16],
          8, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 0], -1, 13, 1, 20],
        ],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.12,
        "text-anchor": "center",
        "text-justify": "center",
        "text-max-width": 8,
        "symbol-placement": "point",
      },
      paint: {
        "text-color": palette.placeLabel,
        "text-halo-color": palette.placeLabelHalo,
        "text-halo-width": 1.4,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.85, 6, 1, 8, 0.85, 9, 0],
      },
    },
    {
      id: "overview-ocean",
      type: "symbol",
      source: "labels",
      filter: ["in", ["get", "kind"], ["literal", ["ocean", "sea"]]],
      minzoom: 3.7,
      maxzoom: 8,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Italic"],
        "text-size": [
          "interpolate", ["linear"], ["zoom"],
          0, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 1], 0, 10, 2, 14, 3, 18],
          4, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 1], 0, 12, 2, 18, 3, 22],
        ],
        "text-letter-spacing": 0.18,
        "text-anchor": "center",
        "text-justify": "center",
        "text-max-width": 8,
        "symbol-placement": "point",
      },
      paint: {
        "text-color": palette.waterLabel,
        "text-halo-color": palette.waterLabelHalo,
        "text-halo-width": 1,
        // Per-feature min_zoom from NE's `min_label`: oceans ~1, major
        // seas ~2-3, gulfs/bays ~5-6. MapLibre requires `["zoom"]` as
        // the top-level input of step/interpolate, so the per-feature
        // gate moves into per-stop case expressions (which don't read
        // zoom themselves). Fade out at 7→8 like before.
        "text-opacity": [
          "step", ["zoom"],
          0,
          1, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 1], 1, 0],
          2, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 2], 1, 0],
          3, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 3], 1, 0],
          4, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 4], 1, 0],
          5, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 5], 1, 0],
          6, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 6], 1, 0],
          7, 1,
          8, 0,
        ],
      },
    },
    {
      id: "overview-lake",
      type: "symbol",
      source: "labels",
      filter: ["==", ["get", "kind"], "lake"],
      minzoom: 4,
      maxzoom: 10,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Italic"],
        "text-size": [
          "interpolate", ["linear"], ["zoom"],
          4, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], -1], -2, 9, 0, 12],
          8, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], -1], -2, 11, 0, 15],
        ],
        "text-anchor": "center",
        "text-justify": "center",
        "text-max-width": 8,
        "symbol-placement": "point",
      },
      paint: {
        "text-color": palette.waterLabel,
        "text-halo-color": palette.waterLabelHalo,
        "text-halo-width": 1,
        // Lake `min_zoom` (NE `min_label`, large lakes ~4, small ~7).
        // Layer already minzoom:4 / maxzoom:10, so we step per integer
        // inside that window. Same restriction as overview-ocean above
        // — `["zoom"]` must be the top-level step input.
        "text-opacity": [
          "step", ["zoom"],
          0,
          4, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 4], 1, 0],
          5, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 5], 1, 0],
          6, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 6], 1, 0],
          7, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 7], 1, 0],
          8, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 8], 1, 0],
          9, ["case", ["<=", ["coalesce", ["get", "min_zoom"], 0], 9], 1, 0],
          10, 1,
        ],
      },
    },
    // ── Globe-level major labels ────────────────────────────────────────────
    // A sparse set of large countries + major oceans shown only on the globe
    // (maxzoom 3.7, where the detailed overview labels above take over).
    // Collision is disabled (allow-overlap / ignore-placement) so labels stay
    // pinned to their feature as the globe auto-rotates instead of flickering
    // on/off as placement re-runs during motion.
    {
      id: "overview-country-globe",
      type: "symbol",
      source: "labels",
      filter: ["all",
        ["==", ["get", "kind"], "country"],
        [">=", ["coalesce", ["get", "area_log"], 0], 1.7],
      ],
      maxzoom: 3.7,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 1.7], 1.7, 12, 2.7, 17],
        "text-anchor": "center",
        "text-justify": "center",
        "text-max-width": 8,
        "symbol-placement": "point",
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": palette.placeLabel,
        "text-halo-color": palette.placeLabelHalo,
        "text-halo-width": 1,
      },
    },
    {
      id: "overview-ocean-globe",
      type: "symbol",
      source: "labels",
      filter: ["all",
        ["in", ["get", "kind"], ["literal", ["ocean", "sea"]]],
        ["<=", ["coalesce", ["get", "min_zoom"], 0], 2],
      ],
      maxzoom: 3.7,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Italic"],
        "text-size": ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 2], 1, 11, 3, 17],
        "text-letter-spacing": 0.18,
        "text-anchor": "center",
        "text-justify": "center",
        "text-max-width": 8,
        "symbol-placement": "point",
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": palette.waterLabel,
        "text-halo-color": palette.waterLabelHalo,
        "text-halo-width": 1,
        "text-opacity": 0.9,
      },
    },
  );

  return {
    version: 8,
    sprite: `${window.location.origin}/sprites/osm-liberty`,
    glyphs: `${window.location.origin}/api/maps/glyphs/{fontstack}/{range}.pbf`,
    sources,
    layers,
  };
}
