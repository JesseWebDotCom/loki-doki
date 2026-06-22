// Road hazard + construction style layers.
// Phase maps-discovery chunk-13.
// All features come from the transportation source layer in existing PMTiles.
// Schema note: verify class/subclass values against actual tile data.

import type { LayerSpecification } from "maplibre-gl";

export function constructionLayers(visible = true): LayerSpecification[] {
  const vis: "visible" | "none" = visible ? "visible" : "none";
  return [
    // Construction zones: orange dashed overlay on road segments z14+.
    // Matches only roads explicitly classed "construction" in Planetiler output.
    // NOTE: ["has", "construction"] removed — it matched too many normal roads
    // in the OpenMapTiles/Planetiler transportation layer schema.
    {
      id: "roads-construction",
      type: "line",
      source: "region",
      "source-layer": "transportation",
      minzoom: 14,
      filter: ["==", ["get", "class"], "construction"],
      layout: { visibility: vis },
      paint: {
        "line-color": "#f97316",
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2, 17, 6],
        "line-dasharray": [2, 2],
        "line-opacity": 0.85,
      },
    } as LayerSpecification,
    // roads-closed layer removed: access=no filter matched too many normal
    // roads in Planetiler tiles (the access property encoding is not reliable
    // for closure detection without verified tile schema inspection).
  ];
}

export function hazardPointLayers(visible = true): LayerSpecification[] {
  const vis: "visible" | "none" = visible ? "visible" : "none";
  const baseCircle = {
    type: "circle" as const,
    source: "region",
    "source-layer": "transportation",
    minzoom: 15,
    layout: { visibility: vis },
  };
  return [
    {
      ...baseCircle,
      id: "hazard-speed-bump",
      filter: ["in", ["get", "traffic_calming"], ["literal", ["bump", "speed_bump", "hump"]]],
      paint: { "circle-radius": 5, "circle-color": "#eab308", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
    } as LayerSpecification,
    {
      ...baseCircle,
      id: "hazard-level-crossing",
      filter: ["==", ["get", "railway"], "level_crossing"],
      paint: { "circle-radius": 5, "circle-color": "#dc2626", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
    } as LayerSpecification,
    {
      ...baseCircle,
      id: "hazard-give-way",
      filter: ["==", ["get", "class"], "give_way"],
      paint: { "circle-radius": 4, "circle-color": "#f59e0b", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
    } as LayerSpecification,
    {
      ...baseCircle,
      id: "hazard-crossing",
      filter: ["all", ["==", ["get", "class"], "crossing"], ["==", ["get", "crossing"], "marked"]],
      paint: { "circle-radius": 4, "circle-color": "#6366f1", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
    } as LayerSpecification,
    {
      ...baseCircle,
      id: "hazard-ford",
      filter: ["==", ["get", "class"], "ford"],
      paint: { "circle-radius": 5, "circle-color": "#0ea5e9", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
    } as LayerSpecification,
  ];
}
