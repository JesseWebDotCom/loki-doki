import type maplibregl from 'maplibre-gl';
import {
  buildDarkStyle,
  type DarkStyleOptions,
  type Palette,
} from './style-dark';

const LIGHT: Palette = {
  background: '#f5f1e8',
  water: '#aad3df',
  water_shadow: '#8bb8c5',
  park: '#c8e0c4',
  residential: '#ebe8e0',
  landuse_park: '#dde9bd',
  landuse_wood: '#d2dfb2',
  landuse_residential: '#efe8de',
  landuse_commercial: '#f2e6da',
  landuse_industrial: '#e1ddd4',
  road_minor: '#ffffff',
  road_secondary: '#f1dc9f',
  road_primary: '#f0b24e',
  road_trunk: '#5aa6f5',
  road_motorway: '#2378f7',
  road_medium: '#f2e5a8',
  road_major: '#e1b84d',
  road_casing: '#b8b2a4',
  road_major_label: '#1f56ac',
  building: '#e3ddcb',
  building_outline: '#c9c2ac',
  boundary_country: '#7c5aa6',
  boundary_state: '#aa92c8',
  place_label: '#1a1d22',
  place_label_halo: '#ffffff',
  street_label: '#2a2e38',
  street_label_halo: '#ffffff',
  water_label: '#3c6a9a',
  water_label_halo: '#ffffff',
  poi_label: '#54595f',
  housenumber: '#6a7080',
};

export function buildLightStyle(
  tileUrl: string,
  overviewUrl: string,
  labelsUrl: string,
  opts: DarkStyleOptions = {},
): maplibregl.StyleSpecification {
  return buildDarkStyle(tileUrl, overviewUrl, labelsUrl, {
    ...opts,
    palette: LIGHT,
  });
}

export default buildLightStyle;
