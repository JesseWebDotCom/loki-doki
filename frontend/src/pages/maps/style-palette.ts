export interface Palette {
  background: string;
  water: string;
  waterShadow: string;
  park: string;
  wood: string;
  grass: string;
  farmland: string;
  wetland: string;
  sand: string;
  rock: string;
  ice: string;
  residential: string;
  commercial: string;
  industrial: string;
  minorRoad: string;
  secondaryRoad: string;
  primaryRoad: string;
  trunkRoad: string;
  motorwayRoad: string;
  roadCasing: string;
  majorRoadLabel: string;
  building: string;
  buildingTall: string;
  buildingOutline: string;
  countryBoundary: string;
  stateBoundary: string;
  placeLabel: string;
  placeLabelHalo: string;
  streetLabel: string;
  streetLabelHalo: string;
  waterLabel: string;
  waterLabelHalo: string;
  poiLabel: string;
  houseNumber: string;
  // Opacity of the satellite landcover raster wash (0–1); lower in dark themes
  // so the naturalistic colours tint rather than overpower the dark base.
  landcoverOpacity: number;
  // True for dark themes — selects readable (lightened) POI label colours.
  isDark: boolean;
}
