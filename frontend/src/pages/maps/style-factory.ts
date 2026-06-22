import type { StyleSpecification } from "maplibre-gl";

import { buildDarkStyle } from "./style-dark";
import { buildLightStyle } from "./style-light";
import { buildSatelliteStyle } from "./style-satellite";
import type { LayerMode } from "./types";

export function buildStyle(
  theme: "light" | "dark",
  tileUrl: string | null,
  overviewUrl: string,
  labelsUrl: string,
  countriesUrl: string,
  statesUrl: string,
  opts: { mode?: LayerMode } = {},
): StyleSpecification {
  if (opts.mode === "satellite") {
    return buildSatelliteStyle(tileUrl, overviewUrl, labelsUrl, countriesUrl, statesUrl);
  }
  return theme === "light"
    ? buildLightStyle(tileUrl, overviewUrl, labelsUrl, countriesUrl, statesUrl, opts)
    : buildDarkStyle(tileUrl, overviewUrl, labelsUrl, countriesUrl, statesUrl, opts);
}
