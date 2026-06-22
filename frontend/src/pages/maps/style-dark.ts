import type { StyleSpecification } from "maplibre-gl";

import { buildMapStyle, type Palette } from "./style-core";
import type { LayerMode } from "./types";

const DARK: Palette = {
  background: "#1f2832",
  water: "#0a2745",
  waterShadow: "#173d5e",
  park: "#1f3f2c",
  wood: "#173824",
  grass: "#244832",
  farmland: "#353f26",
  wetland: "#1b3a31",
  sand: "#3c3a2b",
  rock: "#313742",
  ice: "#33414b",
  residential: "#283142",
  commercial: "#32394a",
  industrial: "#2b3340",
  minorRoad: "#3d434c",
  secondaryRoad: "#8f96a3",
  primaryRoad: "#f1b45a",
  trunkRoad: "#3f92f5",
  motorwayRoad: "#1c6ff2",
  roadCasing: "#1a2230",
  majorRoadLabel: "#93c5fd",
  building: "#5d6675",
  buildingTall: "#79839a",
  buildingOutline: "#a8b1c0",
  countryBoundary: "#b49bff",
  stateBoundary: "#7d6da8",
  placeLabel: "#f0f2f7",
  placeLabelHalo: "#0a0c10",
  streetLabel: "#c7cddd",
  streetLabelHalo: "#0a0c10",
  waterLabel: "#7aa8d8",
  waterLabelHalo: "#0a0c10",
  poiLabel: "#a5adbf",
  houseNumber: "#8892ab",
  landcoverOpacity: 0.5,
  isDark: true,
};

export function buildDarkStyle(
  tileUrl: string | null,
  overviewUrl: string,
  labelsUrl: string,
  countriesUrl: string,
  statesUrl: string,
  opts: { mode?: LayerMode } = {},
): StyleSpecification {
  return buildMapStyle(DARK, tileUrl, overviewUrl, labelsUrl, countriesUrl, statesUrl, opts);
}
