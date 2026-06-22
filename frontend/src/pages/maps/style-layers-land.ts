import type { LayerSpecification } from "maplibre-gl";

import type { Palette } from "./style-palette";

export function landLayers(p: Palette): LayerSpecification[] {
  return [
    { id: "region-water", type: "fill", source: "region", "source-layer": "water", paint: { "fill-color": p.water, "fill-outline-color": p.waterShadow } },
    {
      id: "region-waterway",
      type: "line",
      source: "region",
      "source-layer": "waterway",
      paint: {
        "line-color": p.water,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 16, 2.5],
      },
    },
    {
      id: "region-park",
      type: "fill",
      source: "region",
      "source-layer": "park",
      paint: { "fill-color": p.park, "fill-opacity": 0.7 },
    },
    {
      id: "region-landuse-residential",
      type: "fill",
      source: "region",
      "source-layer": "landuse",
      filter: ["==", ["get", "class"], "residential"],
      paint: { "fill-color": p.residential, "fill-opacity": 0.85 },
    },
    {
      id: "region-landuse-commercial",
      type: "fill",
      source: "region",
      "source-layer": "landuse",
      filter: ["==", ["get", "class"], "commercial"],
      paint: { "fill-color": p.commercial, "fill-opacity": 0.48 },
    },
    {
      id: "region-landuse-industrial",
      type: "fill",
      source: "region",
      "source-layer": "landuse",
      filter: ["==", ["get", "class"], "industrial"],
      paint: { "fill-color": p.industrial, "fill-opacity": 0.5 },
    },
    // ── Natural landcover (OpenMapTiles `landcover` layer `class` values).
    // Opacities raised from the old ~0.5 so vegetation actually reads against
    // the background instead of washing out. wetland/sand/rock/ice were
    // previously unstyled and rendered as bare background. Drawn farmland →
    // grass → scrub → wetland → sand/rock/ice → wood (densest vegetation on top).
    {
      id: "region-landcover-farmland",
      type: "fill",
      source: "region",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "farmland"],
      paint: { "fill-color": p.farmland, "fill-opacity": 0.6 },
    },
    {
      id: "region-landcover-grass",
      type: "fill",
      source: "region",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "grass"],
      paint: { "fill-color": p.grass, "fill-opacity": 0.6 },
    },
    {
      id: "region-landcover-wetland",
      type: "fill",
      source: "region",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wetland"],
      paint: { "fill-color": p.wetland, "fill-opacity": 0.55 },
    },
    {
      id: "region-landcover-sand",
      type: "fill",
      source: "region",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "sand"],
      paint: { "fill-color": p.sand, "fill-opacity": 0.7 },
    },
    {
      id: "region-landcover-rock",
      type: "fill",
      source: "region",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "rock"],
      paint: { "fill-color": p.rock, "fill-opacity": 0.6 },
    },
    {
      id: "region-landcover-ice",
      type: "fill",
      source: "region",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "ice"],
      paint: { "fill-color": p.ice, "fill-opacity": 0.75 },
    },
    {
      id: "region-landcover-wood",
      type: "fill",
      source: "region",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      paint: { "fill-color": p.wood, "fill-opacity": 0.78 },
    },
  ];
}

export function boundaryLayers(p: Palette): LayerSpecification[] {
  return [
    {
      id: "boundary-state",
      type: "line",
      source: "region",
      "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 4],
      paint: { "line-color": p.stateBoundary, "line-width": 0.7, "line-dasharray": [3, 2], "line-opacity": 0.7 },
    },
    {
      id: "boundary-country",
      type: "line",
      source: "region",
      "source-layer": "boundary",
      filter: ["<=", ["get", "admin_level"], 2],
      paint: { "line-color": p.countryBoundary, "line-width": 1.2, "line-opacity": 0.85 },
    },
  ];
}
