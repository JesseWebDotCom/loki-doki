import type { ExpressionSpecification, LayerSpecification } from "maplibre-gl";

import type { Palette } from "./style-palette";

// OpenMapTiles `poi` layer subclass/class → label color.
// Kept in sync with navmap/hooks/poi-icons.ts CLASS_COLOR. These are tuned for
// LIGHT backgrounds (many are deliberately dark/saturated).
const POI_TILE_CLASS_COLORS: Record<string, string> = {
  restaurant: "#e85d04", fast_food: "#f48c06", cafe: "#7b5e3a",
  bar: "#7209b7", pub: "#7209b7", biergarten: "#7209b7",
  ice_cream: "#e9c46a", food_court: "#e85d04",
  pharmacy: "#2d9943", hospital: "#d62839", clinic: "#d62839",
  doctors: "#d62839", dentist: "#2d9943", veterinary: "#2d9943",
  fuel: "#4361ee", supermarket: "#2d9943", convenience: "#2d9943", grocery: "#2d9943",
  hotel: "#0077b6", hostel: "#0077b6", motel: "#0077b6", guest_house: "#0077b6",
  camp_site: "#2d6a4f", bank: "#495057", atm: "#495057", parking: "#1d3557",
  school: "#e76f51", college: "#e76f51", university: "#e76f51", kindergarten: "#e76f51",
  park: "#2d6a4f", shop: "#6d6875", post_office: "#457b9d",
  library: "#c8a820", museum: "#8d6e63", gallery: "#8d6e63",
  cinema: "#264653", theatre: "#264653", place_of_worship: "#8e9aad",
  police: "#1d3a6e", fire_station: "#d62839",
  sports_centre: "#2d9943", stadium: "#2d9943",
  bicycle: "#457b9d", bicycle_rental: "#457b9d",
  car: "#495057", car_repair: "#495057", charging_station: "#4361ee",
  townhall: "#264653", embassy: "#264653",
  nightclub: "#7209b7", casino: "#7209b7", zoo: "#2d6a4f", theme_park: "#e76f51",
};

// Dark-theme variants — same semantic hues, lightened so they stay readable on
// the dark map (the light-tuned dark colours above vanish on a dark background).
const POI_TILE_CLASS_COLORS_DARK: Record<string, string> = {
  restaurant: "#f97316", fast_food: "#fb923c", cafe: "#c79a6a",
  bar: "#b07be0", pub: "#b07be0", biergarten: "#b07be0",
  ice_cream: "#f0d27a", food_court: "#f97316",
  pharmacy: "#4ec06a", hospital: "#f0617a", clinic: "#f0617a",
  doctors: "#f0617a", dentist: "#4ec06a", veterinary: "#4ec06a",
  fuel: "#7d92ff", supermarket: "#4ec06a", convenience: "#4ec06a", grocery: "#4ec06a",
  hotel: "#4aa6e0", hostel: "#4aa6e0", motel: "#4aa6e0", guest_house: "#4aa6e0",
  camp_site: "#5fae87", bank: "#aab3bf", atm: "#aab3bf", parking: "#7d9fe0",
  school: "#f0936a", college: "#f0936a", university: "#f0936a", kindergarten: "#f0936a",
  park: "#5fae87", shop: "#b0aabf", post_office: "#7aa6c8",
  library: "#e0c558", museum: "#c79a8a", gallery: "#c79a8a",
  cinema: "#5f9aae", theatre: "#5f9aae", place_of_worship: "#aab3c8",
  police: "#7d9fe0", fire_station: "#f0617a",
  sports_centre: "#4ec06a", stadium: "#4ec06a",
  bicycle: "#7aa6c8", bicycle_rental: "#7aa6c8",
  car: "#aab3bf", car_repair: "#aab3bf", charging_station: "#7d92ff",
  townhall: "#5f9aae", embassy: "#5f9aae",
  nightclub: "#b07be0", casino: "#b07be0", zoo: "#5fae87", theme_park: "#f0936a",
};

function poiLabelColorExpr(fallback: string, dark: boolean): ExpressionSpecification {
  const colors = dark ? POI_TILE_CLASS_COLORS_DARK : POI_TILE_CLASS_COLORS;
  const pairs = Object.entries(colors).flatMap(([k, v]) => [k, v]);
  return ["match",
    ["coalesce", ["get", "subclass"], ["get", "class"], ""],
    ...pairs,
    fallback,
  ] as unknown as ExpressionSpecification;
}

const nameLabel = ["coalesce", ["get", "name:en"], ["get", "name"]] as ExpressionSpecification;

// For trunk/primary/secondary roads: append ref when present (e.g. "Merritt Pkwy / 15").
// Motorway excluded — Interstate shields are the canonical ref display there.
const roadNameLabel = ["case",
  ["all",
    ["has", "ref"],
    ["in", ["get", "class"], ["literal", ["trunk", "primary", "secondary"]]],
  ],
  ["concat", ["coalesce", ["get", "name:en"], ["get", "name"]], " / ", ["get", "ref"]],
  nameLabel,
] as ExpressionSpecification;

export function placeLabelLayers(p: Palette): LayerSpecification[] {
  return [
    {
      id: "place-city",
      type: "symbol",
      source: "region",
      "source-layer": "place",
      filter: ["==", ["get", "class"], "city"],
      minzoom: 4,
      layout: { "text-field": nameLabel, "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 4, 13, 14, 24] },
      paint: { "text-color": p.placeLabel, "text-halo-color": p.placeLabelHalo, "text-halo-width": 1.5 },
    },
    {
      id: "place-town",
      type: "symbol",
      source: "region",
      "source-layer": "place",
      filter: ["==", ["get", "class"], "town"],
      minzoom: 7,
      layout: { "text-field": nameLabel, "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 12, 14, 20] },
      paint: { "text-color": p.placeLabel, "text-halo-color": p.placeLabelHalo, "text-halo-width": 1.3 },
    },
    {
      id: "place-village",
      type: "symbol",
      source: "region",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["village", "hamlet"]]],
      minzoom: 10,
      layout: { "text-field": nameLabel, "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 10, 12, 16, 17] },
      paint: { "text-color": p.placeLabel, "text-halo-color": p.placeLabelHalo, "text-halo-width": 1.2 },
    },
    {
      id: "place-neighborhood",
      type: "symbol",
      source: "region",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood"]]],
      minzoom: 12,
      layout: {
        "text-field": nameLabel,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 12, 16, 15],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08,
      },
      paint: { "text-color": p.placeLabel, "text-halo-color": p.placeLabelHalo, "text-halo-width": 1, "text-opacity": 0.85 },
    },
  ];
}

export function streetLabelLayers(p: Palette): LayerSpecification[] {
  return [
    {
      id: "street-label-major",
      type: "symbol",
      source: "region",
      "source-layer": "transportation_name",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]],
      minzoom: 9,
      layout: {
        "symbol-placement": "line",
        "text-field": roadNameLabel,
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 12, 14, 15, 18, 20],
        "text-letter-spacing": 0.04,
        "text-max-angle": 30,
      },
      paint: { "text-color": p.majorRoadLabel, "text-halo-color": p.streetLabelHalo, "text-halo-width": 1.8 },
    },
    {
      id: "street-label-medium",
      type: "symbol",
      source: "region",
      "source-layer": "transportation_name",
      filter: ["in", ["get", "class"], ["literal", ["secondary", "tertiary"]]],
      minzoom: 11,
      layout: {
        "symbol-placement": "line",
        "text-field": roadNameLabel,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 14, 13, 18, 17],
        "text-letter-spacing": 0.02,
        "text-max-angle": 30,
      },
      paint: { "text-color": p.streetLabel, "text-halo-color": p.streetLabelHalo, "text-halo-width": 1.4 },
    },
    {
      id: "street-label-minor",
      type: "symbol",
      source: "region",
      "source-layer": "transportation_name",
      filter: ["in", ["get", "class"], ["literal", ["minor", "service", "residential"]]],
      minzoom: 14,
      layout: {
        // Curve the name along the road (Apple Maps' actual treatment) so
        // minor streets read like major streets, not floating white pills.
        // MapLibre will skip segments too short to fit the label, which
        // naturally thins dense residential grids.
        "symbol-placement": "line",
        "text-field": nameLabel,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 13],
        "text-letter-spacing": 0.02,
        "text-max-angle": 30,
        "text-padding": 4,
      },
      paint: {
        "text-color": p.streetLabel,
        "text-halo-color": p.streetLabelHalo,
        "text-halo-width": 1.2,
      },
    },
  ];
}

export function routeShieldLayers(): LayerSpecification[] {
  return [
    {
      id: "route-shield-motorway",
      type: "symbol",
      source: "region",
      "source-layer": "transportation_name",
      filter: ["all", ["==", ["get", "class"], "motorway"], ["has", "ref"]],
      minzoom: 8,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 280,
        "icon-pitch-alignment": "viewport",
        "text-pitch-alignment": "viewport",
        "icon-image": "shield_interstate",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 1.05, 14, 1.3, 18, 1.55],
        "icon-allow-overlap": true,
        "icon-text-fit": "both",
        "icon-text-fit-padding": [4, 8, 4, 8],
        "text-field": ["get", "ref"],
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 11, 14, 13, 18, 16],
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#ffffff" },
    },
    {
      id: "route-shield-us",
      type: "symbol",
      source: "region",
      "source-layer": "transportation_name",
      filter: ["all", ["==", ["get", "class"], "trunk"], ["has", "ref"], ["!", ["has", "name"]]],
      minzoom: 9,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 280,
        "icon-pitch-alignment": "viewport",
        "text-pitch-alignment": "viewport",
        "icon-image": "shield_us",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 1.0, 14, 1.25, 18, 1.5],
        "icon-allow-overlap": true,
        "icon-text-fit": "both",
        "icon-text-fit-padding": [4, 8, 4, 8],
        "text-field": ["get", "ref"],
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 12, 18, 15],
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#1f232b" },
    },
    {
      id: "route-shield-state",
      type: "symbol",
      source: "region",
      "source-layer": "transportation_name",
      filter: ["all", ["in", ["get", "class"], ["literal", ["primary", "secondary"]]], ["has", "ref"], ["!", ["has", "name"]]],
      minzoom: 10,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 260,
        "icon-pitch-alignment": "viewport",
        "text-pitch-alignment": "viewport",
        "icon-image": "shield_state",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.95, 14, 1.2, 18, 1.45],
        "icon-allow-overlap": true,
        "icon-text-fit": "both",
        "icon-text-fit-padding": [4, 8, 4, 8],
        "text-field": ["get", "ref"],
        "text-font": ["Noto Sans Medium"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 12, 18, 14],
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#3b3628" },
    },
  ];
}

export function waterPoiAndHouseLayers(p: Palette): LayerSpecification[] {
  return [
    {
      id: "water-name",
      type: "symbol",
      source: "region",
      "source-layer": "water_name",
      minzoom: 9,
      layout: {
        "text-field": nameLabel,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 12, 16, 17],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.1,
        "text-max-width": 8,
      },
      paint: { "text-color": p.waterLabel, "text-halo-color": p.waterLabelHalo, "text-halo-width": 1.2 },
    },
    {
      id: "waterway-label",
      type: "symbol",
      source: "region",
      "source-layer": "waterway",
      filter: ["has", "name"],
      minzoom: 12,
      layout: {
        "symbol-placement": "line",
        "text-field": nameLabel,
        "text-font": ["Noto Sans Italic"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 18, 13],
        "text-letter-spacing": 0.05,
      },
      paint: { "text-color": p.waterLabel, "text-halo-color": p.waterLabelHalo, "text-halo-width": 1 },
    },
    {
      id: "housenumber",
      type: "symbol",
      source: "region",
      "source-layer": "housenumber",
      minzoom: 14,
      layout: {
        "text-field": ["get", "housenumber"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14, 9, 17, 12, 20, 14],
      },
      paint: {
        "text-color": p.houseNumber,
        "text-halo-color": p.placeLabelHalo,
        "text-halo-width": 0.8,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, 1] as unknown as number,
      },
    },
    {
      id: "poi-label",
      type: "symbol",
      source: "region",
      "source-layer": "poi",
      filter: ["has", "name"],
      minzoom: 16,
      layout: {
        "icon-image": ["coalesce", ["get", "subclass"], ["get", "class"], "poi"] as unknown as string,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 16, 0.75, 18, 1.05] as unknown as number,
        "icon-allow-overlap": false,
        "icon-optional": false,
        "text-field": nameLabel,
        "text-font": ["Noto Sans Medium"] as unknown as string[],
        "text-size": ["interpolate", ["linear"], ["zoom"], 16, 11, 18, 14] as unknown as number,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
        "text-max-width": 9,
        "text-allow-overlap": false,
        "text-optional": false,
        "text-padding": 4,
      },
      paint: {
        "text-color": ["case",
          ["boolean", ["feature-state", "selected"], false],
          "#3b82f6",
          poiLabelColorExpr(p.poiLabel, p.isDark),
        ] as unknown as string,
        "text-halo-color": p.placeLabelHalo,
        "text-halo-width": ["case",
          ["boolean", ["feature-state", "selected"], false],
          3.5,
          2.5,
        ] as unknown as number,
      },
    },
  ];
}
