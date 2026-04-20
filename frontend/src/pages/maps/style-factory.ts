import type maplibregl from 'maplibre-gl';
import { buildDarkStyle, type LayerMode } from './style-dark';
import { buildLightStyle } from './style-light';

export type MapColorTheme = 'dark' | 'light';

interface BuildStyleOptions {
  mode?: LayerMode;
}

export function buildStyle(
  theme: MapColorTheme,
  tileUrl: string,
  overviewUrl: string,
  labelsUrl: string,
  opts: BuildStyleOptions = {},
): maplibregl.StyleSpecification {
  if (theme === 'light') {
    return buildLightStyle(tileUrl, overviewUrl, labelsUrl, opts);
  }
  return buildDarkStyle(tileUrl, overviewUrl, labelsUrl, opts);
}
