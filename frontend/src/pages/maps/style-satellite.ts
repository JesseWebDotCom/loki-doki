import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

import { roadLayers } from "./style-layers-roads";
import {
  placeLabelLayers,
  routeShieldLayers,
  streetLabelLayers,
  waterPoiAndHouseLayers,
} from "./style-layers-labels";
import type { Palette } from "./style-palette";

// High-contrast palette for labels and road overlays on top of satellite imagery.
const SAT: Palette = {
  background: "#111827",
  water: "transparent",
  waterShadow: "transparent",
  park: "transparent",
  wood: "transparent",
  grass: "transparent",
  farmland: "transparent",
  residential: "transparent",
  commercial: "transparent",
  industrial: "transparent",
  minorRoad: "rgba(255,255,255,0.55)",
  secondaryRoad: "rgba(255,255,255,0.78)",
  primaryRoad: "#fcd34d",
  trunkRoad: "#60a5fa",
  motorwayRoad: "#60a5fa",
  roadCasing: "rgba(0,0,0,0.55)",
  majorRoadLabel: "#fcd34d",
  building: "rgba(255,255,255,0.07)",
  buildingOutline: "rgba(255,255,255,0.15)",
  countryBoundary: "rgba(220,180,255,0.9)",
  stateBoundary: "rgba(180,140,230,0.7)",
  placeLabel: "#ffffff",
  placeLabelHalo: "rgba(0,0,0,0.75)",
  streetLabel: "#ffffff",
  streetLabelHalo: "rgba(0,0,0,0.75)",
  waterLabel: "#7dd3fc",
  waterLabelHalo: "rgba(0,0,0,0.75)",
  poiLabel: "#ffffff",
  houseNumber: "rgba(255,255,255,0.45)",
};

const ESRI_SAT =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export function buildSatelliteStyle(
  tileUrl: string | null,
  overviewUrl: string,
  labelsUrl: string,
  countriesUrl: string,
  statesUrl: string,
): StyleSpecification {
  const sources: StyleSpecification["sources"] = {
    satellite: {
      type: "raster",
      tiles: [ESRI_SAT],
      tileSize: 256,
      attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      maxzoom: 19,
    },
    overview: { type: "vector", url: overviewUrl, maxzoom: 7 },
    labels: { type: "geojson", data: labelsUrl },
    countries: { type: "geojson", data: countriesUrl },
    states: { type: "geojson", data: statesUrl },
  };
  if (tileUrl) {
    sources.region = { type: "vector", url: tileUrl };
  }

  const layers: LayerSpecification[] = [
    { id: "satellite-raster", type: "raster", source: "satellite" },
    {
      id: "sat-country-outline",
      type: "line",
      source: "countries",
      paint: {
        "line-color": SAT.countryBoundary,
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.8, 4, 1.4, 8, 1.8],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.9, 9, 0.55],
      },
    } as LayerSpecification,
    {
      id: "sat-state-outline",
      type: "line",
      source: "states",
      minzoom: 2,
      maxzoom: 9,
      paint: {
        "line-color": SAT.stateBoundary,
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 5, 1.0, 8, 1.3],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 4, 0.85, 9, 0],
        "line-dasharray": [3, 2],
      },
    } as LayerSpecification,
  ];

  if (tileUrl) {
    layers.push(
      ...roadLayers(SAT),
      // POI icons/labels (+ water/house labels). The `poi-label` layer here is
      // what use-map-click / use-hover-wire / use-poi-prefetch query — without it
      // satellite mode has no clickable/hoverable POIs. Drawn under street/place
      // labels to match the 2D/dark draw order.
      ...waterPoiAndHouseLayers(SAT),
      ...streetLabelLayers(SAT),
      ...routeShieldLayers(),
      ...placeLabelLayers(SAT),
    );
  }

  // Country / state / ocean labels from GeoJSON (always present, independent of region tiles)
  layers.push(
    {
      id: "sat-country-label",
      type: "symbol",
      source: "labels",
      filter: ["==", ["get", "kind"], "country"],
      maxzoom: 5,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Medium"],
        "text-size": [
          "interpolate", ["linear"], ["zoom"],
          0, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 1], 0, 9, 1.5, 11, 2.7, 15],
          4, ["interpolate", ["linear"], ["coalesce", ["get", "area_log"], 1], 0, 11, 1.5, 14, 2.7, 20],
        ],
        "text-anchor": "center",
        "text-max-width": 8,
        "symbol-placement": "point",
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": SAT.placeLabel,
        "text-halo-color": SAT.placeLabelHalo,
        "text-halo-width": 1.5,
      },
    } as LayerSpecification,
    {
      id: "sat-state-label",
      type: "symbol",
      source: "labels",
      filter: ["==", ["get", "kind"], "state"],
      minzoom: 3,
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
        "text-max-width": 8,
        "symbol-placement": "point",
      },
      paint: {
        "text-color": SAT.placeLabel,
        "text-halo-color": SAT.placeLabelHalo,
        "text-halo-width": 1.5,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.85, 6, 1, 8, 0.85, 9, 0],
      },
    } as LayerSpecification,
    {
      id: "sat-ocean-label",
      type: "symbol",
      source: "labels",
      filter: ["in", ["get", "kind"], ["literal", ["ocean", "sea"]]],
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
        "text-max-width": 8,
        "symbol-placement": "point",
      },
      paint: {
        "text-color": SAT.waterLabel,
        "text-halo-color": SAT.waterLabelHalo,
        "text-halo-width": 1,
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
    } as LayerSpecification,
  );

  return {
    version: 8,
    sprite: `${window.location.origin}/sprites/osm-liberty`,
    glyphs: `${window.location.origin}/api/maps/glyphs/{fontstack}/{range}.pbf`,
    sources,
    layers,
  };
}
