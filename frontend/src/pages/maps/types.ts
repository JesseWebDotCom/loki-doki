export type LayerMode = "map" | "3d" | "satellite";
export type PanelKind = "search" | "guides" | "directions" | "pins" | "settings" | null;

export interface PlaceResult {
  place_id: string;
  title: string;
  subtitle: string;
  address_lines: string[];
  lat: number;
  lon: number;
  kind?: string;
  phone?: string | null;
  website?: string | null;
  distance_m?: number | null;
  // Phase maps-discovery chunk-02: opening hours
  opening_hours_raw?: string | null;
  open_now?: boolean | null;
  closes_at?: string | null;
  opens_at?: string | null;
  // Phase maps-discovery chunk-08: Wikidata brand QID
  brand_qid?: string | null;
  // Phase maps-discovery chunk-09: offline Wikipedia summary
  wiki_summary?: string | null;
  wiki_url?: string | null;
  menu_url?: string | null;
  // Phase maps-discovery chunk-07: business attributes
  business_attrs?: {
    contactless?: boolean;
    credit_cards?: boolean;
    wheelchair?: "yes" | "limited" | "no";
    wifi?: string;
    cuisine?: string[];
    outdoor_seating?: boolean;
    vegan?: boolean;
    vegetarian?: boolean;
    takeaway?: boolean;
    delivery?: boolean;
    stars?: number;
    fee?: boolean;
    smoking?: string;
    brand?: string;
  } | null;
}

export interface Recent extends PlaceResult {
  selected_at: number; // epoch ms
}

export const PIN_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "gray",
] as const;
export type PinColor = (typeof PIN_COLORS)[number];

export interface SavedPin {
  pin_id: string;
  label: string;
  lat: number;
  lon: number;
  color: PinColor;
  place_ref: PlaceResult | null;
  created_at: string;
  notes?: string | null;  // Phase maps-discovery chunk-05
  collection_id?: string | null;  // Phase maps-skill chunk-03
}

export interface DeepLink {
  fromPlace?: PlaceResult;
  toPlace?: PlaceResult;
  mode?: "auto" | "pedestrian" | "bicycle";
  focusPlace?: PlaceResult;
  searchQuery?: string;
  searchCategory?: string;
}

export interface InstalledRegion {
  region_id: string;
  label: string;
  bbox: [number, number, number, number];
  center: { lat: number; lon: number };
}
