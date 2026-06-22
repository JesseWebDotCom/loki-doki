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
  const base =
    opts.mode === "satellite"
      ? buildSatelliteStyle(tileUrl, overviewUrl, labelsUrl, countriesUrl, statesUrl)
      : theme === "light"
        ? buildLightStyle(tileUrl, overviewUrl, labelsUrl, countriesUrl, statesUrl, opts)
        : buildDarkStyle(tileUrl, overviewUrl, labelsUrl, countriesUrl, statesUrl, opts);
  // Globe projection: the earth is a sphere at low zoom and smoothly morphs to
  // flat as you zoom in (MapLibre 5 native — no extra dependency). Baked into
  // the style itself so it survives the repeated setStyle() calls in MapsPage
  // (theme / region / layer-mode switches), which would otherwise reset it.
  //
  // `sky` adds the atmospheric rim-glow that hugs the globe edge. atmosphere-blend
  // fades to 0 by city zooms so it never tints the street view, and in globe view
  // only the halo ring is drawn — the deep void stays transparent so the
  // SpaceBackdrop starfield shows through behind the canvas.
  return {
    ...base,
    projection: { type: "globe" },
    sky: {
      "sky-color": "#0a1330",
      "sky-horizon-blend": 0.6,
      "horizon-color": "#2a4a8f",
      "horizon-fog-blend": 0.7,
      "fog-color": "#0a1330",
      "fog-ground-blend": 0.4,
      "atmosphere-blend": [
        "interpolate",
        ["linear"],
        ["zoom"],
        0, 0.9,
        4, 0.6,
        6, 0.1,
        7, 0,
      ],
    },
  };
}
