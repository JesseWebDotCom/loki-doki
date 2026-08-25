// Ordered category metadata for the ExplorePanel chip grid.
// Phase maps-discovery chunk-03. Must stay in sync with
// the v2 app's maps/geocode/_categories.py SEARCHABLE_CATEGORIES.

export interface ExploreCategory {
  slug: string;
  label: string;
}

// 4-wide grid: Food & drink | Personal care | Health | Civic | Lodging | Entertainment
export const EXPLORE_CATEGORIES: ExploreCategory[] = [
  // Row 1 — Food & drink
  { slug: "restaurant", label: "Restaurants" },
  { slug: "cafe",       label: "Cafés" },
  { slug: "bar",        label: "Bars" },
  { slug: "grocery",    label: "Grocery" },
  // Row 2 — Personal care
  { slug: "hairdresser", label: "Hair" },
  { slug: "barber",      label: "Barber" },
  { slug: "beauty",      label: "Beauty" },
  { slug: "gym",         label: "Gym" },
  // Row 3 — Health
  { slug: "pharmacy",  label: "Pharmacy" },
  { slug: "hospital",  label: "Hospital" },
  { slug: "clinic",    label: "Clinic" },
  { slug: "dentist",   label: "Dentist" },
  // Row 4 — Civic & services
  { slug: "library",     label: "Library" },
  { slug: "bank",        label: "Bank" },
  { slug: "post_office", label: "Post" },
  { slug: "laundry",     label: "Laundry" },
  // Row 5 — Lodging & travel
  { slug: "hotel",       label: "Hotels" },
  { slug: "gas_station", label: "Gas" },
  { slug: "atm",         label: "ATM" },
  { slug: "parking",     label: "Parking" },
  // Row 6 — Entertainment
  { slug: "museum",   label: "Museums" },
  { slug: "cinema",   label: "Cinema" },
  { slug: "park",     label: "Parks" },
  { slug: "optician", label: "Optician" },
];
