import type { StyleSpecification } from "maplibre-gl";

import { buildMapStyle, type Palette } from "./style-core";
import type { LayerMode } from "./types";

const LIGHT: Palette = {
  background: "#f5efe2",
  water: "#b5dcfb",
  waterShadow: "#9ec9eb",
  park: "#bfe0a6",
  wood: "#a6cf83",
  grass: "#cfeab4",
  farmland: "#e9dca8",
  wetland: "#bcdcc8",
  sand: "#efe6c4",
  rock: "#ddd6c9",
  ice: "#e8f1f6",
  residential: "#f3ede2",
  commercial: "#efe9dd",
  industrial: "#e5ddcf",
  minorRoad: "#ffffff",
  secondaryRoad: "#f6dc94",
  primaryRoad: "#f7bd5e",
  trunkRoad: "#56a0f6",
  motorwayRoad: "#2f7df8",
  roadCasing: "#e8dfd1",
  majorRoadLabel: "#255ba8",
  building: "#e3dccf",
  buildingTall: "#cdbfa6",
  buildingOutline: "#cfc6b4",
  countryBoundary: "#8f75b7",
  stateBoundary: "#b29dcc",
  placeLabel: "#1a1d22",
  placeLabelHalo: "#ffffff",
  streetLabel: "#3f444c",
  streetLabelHalo: "#ffffff",
  waterLabel: "#3c6a9a",
  waterLabelHalo: "#ffffff",
  poiLabel: "#4d535d",
  houseNumber: "#6c7380",
  landcoverOpacity: 0.9,
  isDark: false,
};

export function buildLightStyle(
  tileUrl: string | null,
  overviewUrl: string,
  labelsUrl: string,
  countriesUrl: string,
  statesUrl: string,
  opts: { mode?: LayerMode } = {},
): StyleSpecification {
  return buildMapStyle(LIGHT, tileUrl, overviewUrl, labelsUrl, countriesUrl, statesUrl, opts);
}
