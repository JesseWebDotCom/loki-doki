/**
 * Per-category POI fill colors. Single source of truth for the marker
 * background (`missing-image-loader.ts`), the hover-card avatar circle
 * (`PoiHoverPreview.tsx`), and the hover spotlight overlay
 * (`use-hover-spotlight.ts`).
 *
 * Keep keys in sync with `POI_LUCIDE_ICON` / `POI_CATEGORY_ICON`. A missing
 * key falls back to `default`.
 */
import { poiCategoryIconId } from "./poi-icons";

export const POI_BG_COLORS: Record<string, string> = {
  // Food & drink
  restaurant: "#ff8b3d",
  cafe: "#d18b52",
  fast_food: "#ff5a5f",
  ice_cream: "#ff8fb3",
  bar: "#8f7cff",
  pub: "#6957d8",
  wine: "#7a3b8a",
  bakery: "#d49a5c",

  // Groceries / retail
  grocery: "#39b56a",
  shop: "#49a7ff",
  convenience: "#00a88f",
  marketplace: "#3fa46a",

  // Apparel & beauty
  salon: "#c95a8f",
  beauty: "#ff67b8",
  clothing: "#5b8def",
  shoes: "#9b6cc7",
  jewelry: "#b88ce0",
  gift: "#ff5e8a",
  tobacco: "#7a5a3a",

  // Health
  pharmacy: "#ff5aa5",
  hospital: "#ff5b55",
  clinic: "#ff7d9d",
  optician: "#5a7fbe",
  vet: "#b08648",
  pet: "#b08648",

  // Tech / home
  electronics: "#3aa8c5",
  phone_shop: "#3aa8c5",
  furniture: "#a07a52",
  hardware: "#8a6a3f",
  gardencenter: "#5fa648",
  florist: "#e76aa3",

  // Auto
  car_dealer: "#4a90e2",
  auto_repair: "#7a8797",
  bike: "#4a90e2",

  // Money / office
  bank: "#4f7df3",
  atm: "#2f66ef",
  office_generic: "#6f7aa0",
  lawyer: "#8a6f4a",

  // Fuel / parking
  gas: "#ff9f3f",
  charging: "#22c55e",
  parking: "#7a8797",

  // Education
  school: "#f0c13a",
  library: "#d2a525",

  // Culture / entertainment
  museum: "#b085ff",
  gallery: "#a06fdc",
  cinema: "#d04f78",
  theatre: "#c25a9a",
  music: "#9b59b6",
  nightclub: "#7a3b8a",

  // Tourism
  hotel: "#11b6c9",
  lodging: "#0f99b3",
  tourist_info: "#3a9fff",
  attraction: "#e07a4a",
  camp: "#7a9a3b",
  marina: "#1f8db5",

  // Sports & leisure
  gym: "#ff7a3b",
  sports: "#ff8a3b",
  golf: "#4ea35e",
  bowling: "#d4a04a",

  // Transit
  transit_bus: "#25b8aa",
  transit_train: "#31b36f",
  transit_subway: "#1ea86d",
  airport: "#7d67f8",

  // Parks
  park: "#39ab58",

  // Civic
  place_of_worship: "#ff6b8a",
  post: "#ff7e7e",
  police: "#5d97ff",
  fire_station: "#ef4d4d",
  government: "#6e7e9a",
  community_centre: "#7a9ad8",
  funeral: "#6b6f7a",

  default: "#6b7280",
};

export function poiBgColorFromIconId(iconId: string | null | undefined): string {
  if (!iconId) return POI_BG_COLORS.default;
  return POI_BG_COLORS[iconId] ?? POI_BG_COLORS.default;
}

export function poiBgColorFromCategory(category: string | null | undefined): string {
  return poiBgColorFromIconId(poiCategoryIconId(category));
}
