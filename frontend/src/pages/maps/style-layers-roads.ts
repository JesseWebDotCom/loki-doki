import type { LayerSpecification } from "maplibre-gl";

import type { Palette } from "./style-palette";

// Phase maps-discovery chunk-14: speed limit label layer (z16+).
// Renders when road features carry a `maxspeed` property (requires custom
// Planetiler profile; absent in default OMT export — layer renders nothing).
export function speedLimitLayer(): LayerSpecification {
  return {
    id: "speed-limits",
    type: "symbol",
    source: "region",
    "source-layer": "transportation",
    minzoom: 16,
    filter: ["has", "maxspeed"],
    layout: {
      "text-field": ["concat", ["get", "maxspeed"], ""],
      "text-size": 10,
      "text-font": ["Noto Sans Bold"],
      "symbol-placement": "line",
      "symbol-spacing": 200,
    },
    paint: {
      "text-color": "#1e293b",
      "text-halo-color": "#fff",
      "text-halo-width": 1.5,
    },
  } as LayerSpecification;
}

export function roadLayers(p: Palette): LayerSpecification[] {
  return [
    {
      id: "roads-casing",
      type: "line",
      source: "region",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
      minzoom: 7,
      paint: {
        "line-color": p.roadCasing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.8, 12, 4.2, 18, 15.5],
        "line-opacity": 0.78,
      },
    },
    {
      id: "roads-path",
      type: "line",
      source: "region",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["path", "track"]]],
      minzoom: 13,
      paint: {
        "line-color": p.minorRoad,
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.4, 18, 1.5],
        "line-dasharray": [2, 2],
        "line-opacity": 0.7,
      },
    },
    {
      // Thin darker casing under minor roads at street zooms (Apple Maps /
      // Google Material trick) — gives the road network a subtle extruded
      // feel without 3D. Drawn before `roads-minor` so the brighter body
      // sits on top.
      id: "roads-minor-casing",
      type: "line",
      source: "region",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["minor", "service", "residential"]]],
      minzoom: 15,
      paint: {
        "line-color": p.roadCasing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1.2, 16, 3.2, 18, 6.2],
        "line-opacity": 0.7,
      },
    },
    {
      id: "roads-minor",
      type: "line",
      source: "region",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["minor", "service", "residential"]]],
      minzoom: 13,
      paint: {
        "line-color": p.minorRoad,
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 16, 2.4, 18, 5],
      },
    },
    {
      id: "roads-tertiary",
      type: "line",
      source: "region",
      "source-layer": "transportation",
      filter: ["==", ["get", "class"], "tertiary"],
      minzoom: 8,
      paint: {
        "line-color": p.minorRoad,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 2.6, 18, 6.8],
      },
    },
    {
      id: "roads-medium-base",
      type: "line",
      source: "region",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["secondary", "primary"]]],
      minzoom: 6,
      paint: {
        "line-color": p.secondaryRoad,
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.0, 12, 2.8, 16, 7.2],
      },
    },
    {
      id: "roads-major",
      type: "line",
      source: "region",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk"]]],
      minzoom: 4,
      paint: {
        "line-color": ["match", ["get", "class"], "motorway", p.motorwayRoad, "trunk", p.trunkRoad, p.primaryRoad],
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.4, 8, 2.6, 12, 5.2, 16, 10.8],
        "line-opacity": 0.98,
      },
    },
    {
      id: "roads-medium-colored",
      type: "line",
      source: "region",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["secondary", "primary"]]],
      minzoom: 8,
      paint: {
        "line-color": ["match", ["get", "class"], "primary", p.primaryRoad, "secondary", p.secondaryRoad, p.secondaryRoad],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.0, 12, 2.6, 16, 6.6],
        "line-opacity": 0.95,
      },
    },
  ];
}

// Soft ambient drop-shadow rendered as a translated fill underneath the
// building polygon. The SE offset + low-opacity dark fill approximates the
// rasterized shadow Apple Maps uses for its 3D buildings.
export function buildingsShadowLayer(): LayerSpecification {
  return {
    id: "buildings-shadow",
    type: "fill",
    source: "region",
    "source-layer": "building",
    minzoom: 14,
    paint: {
      "fill-color": "#1a1d22",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.1, 18, 0.22],
      "fill-translate": [2, 3],
      "fill-translate-anchor": "viewport",
    },
  };
}

export function buildings2dLayer(p: Palette): LayerSpecification {
  return {
    id: "buildings-2d",
    type: "fill",
    source: "region",
    "source-layer": "building",
    minzoom: 14,
    paint: {
      // Honour OSM `building:colour` where mapped; otherwise grade the fill by
      // height so big-footprint/tall structures (malls, offices) read distinctly
      // from low houses instead of one flat grey.
      "fill-color": [
        "coalesce",
        ["get", "colour"],
        [
          "interpolate", ["linear"], ["coalesce", ["to-number", ["get", "render_height"]], 6],
          6, p.building,
          30, p.buildingTall,
        ],
      ],
      "fill-opacity": 0.95,
    },
  };
}

export function buildings2dOutlineLayer(p: Palette): LayerSpecification {
  return {
    id: "buildings-2d-outline",
    type: "line",
    source: "region",
    "source-layer": "building",
    minzoom: 14,
    paint: {
      "line-color": p.buildingOutline,
      "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.4, 16, 0.9, 19, 1.6],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.5, 16, 0.85, 18, 1.0],
    },
  };
}

export function buildings3dLayer(p: Palette): LayerSpecification {
  return {
    id: "buildings-3d",
    type: "fill-extrusion",
    source: "region",
    "source-layer": "building",
    minzoom: 13,
    paint: {
      "fill-extrusion-color": [
        "coalesce",
        ["get", "colour"],
        [
          "interpolate",
          ["linear"],
          ["coalesce", ["to-number", ["get", "render_height"]], 8],
          8, p.building,
          40, p.buildingOutline,
          120, p.buildingTall,
        ],
      ],
      "fill-extrusion-height": [
        "interpolate",
        ["linear"],
        ["zoom"],
        13, 0,
        14, ["coalesce", ["to-number", ["get", "render_height"]], 8],
      ],
      "fill-extrusion-base": ["coalesce", ["to-number", ["get", "render_min_height"]], 0],
      "fill-extrusion-opacity": 0.94,
      "fill-extrusion-vertical-gradient": true,
    },
  };
}
