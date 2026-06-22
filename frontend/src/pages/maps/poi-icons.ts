/**
 * Shared POI category → sprite icon id map for the click-opened
 * PlaceDetailsCard, the hover preview, and the runtime POI overlay.
 *
 * Lookup order in `poiCategoryIconId`:
 *   1. full category string (e.g. `poi:amenity:restaurant`)
 *   2. parsed FTS value (e.g. `restaurant`, `bowling_alley`)
 *   3. parsed FTS key (e.g. `amenity`, `leisure`, `shop`)
 *
 * So adding a *value* entry below upgrades any `poi:<any>:<value>` row to a
 * specific icon, while *key* entries are the coarse fallback when the
 * value is unrecognized.
 */
export const POI_CATEGORY_ICON: Record<string, string> = {
  // Food & drink
  restaurant: "restaurant",
  cafe: "cafe",
  coffee: "cafe",
  tea: "cafe",
  fast_food: "fast_food",
  food_court: "fast_food",
  ice_cream: "ice_cream",
  bar: "bar",
  pub: "pub",
  brewery: "pub",
  winery: "wine",
  wine: "wine",
  alcohol: "wine",
  beverages: "wine",
  bakery: "bakery",
  pastry: "bakery",
  confectionery: "bakery",
  chocolate: "bakery",

  // Groceries
  grocery: "grocery",
  supermarket: "grocery",
  convenience: "convenience",
  deli: "grocery",
  butcher: "grocery",
  seafood: "grocery",
  greengrocer: "grocery",
  farm: "grocery",

  // Retail (generic + specific)
  shop: "shop",
  mall: "shop",
  department_store: "shop",
  variety_store: "shop",
  general: "shop",
  wholesale: "shop",
  marketplace: "shop",
  second_hand: "shop",
  charity: "shop",
  books: "shop",
  stationery: "shop",
  toys: "gift",
  gift: "gift",
  party: "gift",
  jewelry: "jewelry",
  clothes: "clothing",
  boutique: "clothing",
  tailor: "clothing",
  bag: "clothing",
  fashion: "clothing",
  shoes: "shoes",
  beauty: "beauty",
  cosmetics: "beauty",
  perfumery: "beauty",
  nails: "beauty",
  massage: "beauty",
  tattoo: "beauty",
  hairdresser: "salon",
  barber: "salon",
  hairdresser_supply: "salon",
  pet: "pet",
  pet_grooming: "pet",

  // Electronics & tech
  electronics: "electronics",
  computer: "electronics",
  hifi: "electronics",
  video_games: "electronics",
  mobile_phone: "phone_shop",
  telecommunication: "phone_shop",

  // Home & furniture
  furniture: "furniture",
  interior_decoration: "furniture",
  bed: "furniture",
  kitchen: "furniture",
  appliance: "furniture",
  houseware: "furniture",
  carpet: "furniture",
  curtain: "furniture",

  // Hardware / DIY
  hardware: "hardware",
  doityourself: "hardware",
  paint: "hardware",
  flooring: "hardware",
  trade: "hardware",

  // Garden & florist
  garden_centre: "gardencenter",
  florist: "florist",

  // Auto
  car: "car_dealer",
  car_rental: "car_dealer",
  motorcycle: "car_dealer",
  boat: "car_dealer",
  car_repair: "auto_repair",
  car_parts: "auto_repair",
  tyres: "auto_repair",
  car_wash: "auto_repair",
  bicycle: "bike",
  bicycle_rental: "bike",

  // Health
  pharmacy: "pharmacy",
  chemist: "pharmacy",
  medical_supply: "pharmacy",
  nutrition_supplements: "pharmacy",
  hospital: "hospital",
  clinic: "clinic",
  doctors: "clinic",
  dentist: "clinic",
  psychotherapist: "clinic",
  physiotherapist: "clinic",
  optometrist: "optician",
  optician: "optician",
  hearing_aids: "optician",
  veterinary: "vet",

  // Money & office
  bank: "bank",
  atm: "atm",
  financial: "bank",
  financial_advisor: "bank",
  pawnbroker: "bank",
  insurance: "office_generic",
  estate_agent: "office_generic",
  tax_advisor: "office_generic",
  accountant: "office_generic",
  lawyer: "lawyer",
  notary: "lawyer",
  company: "office_generic",
  employment_agency: "office_generic",
  ngo: "office_generic",
  newspaper: "office_generic",
  research: "office_generic",
  architect: "office_generic",
  association: "office_generic",
  educational_institution: "office_generic",
  construction_company: "office_generic",
  travel_agency: "office_generic",

  // Fuel & parking
  fuel: "gas",
  gas: "gas",
  charging_station: "charging",
  parking: "parking",

  // Education
  school: "school",
  college: "school",
  university: "school",
  kindergarten: "school",
  prep_school: "school",
  childcare: "school",
  driving_school: "school",
  language_school: "school",
  library: "library",
  public_bookcase: "library",

  // Culture & entertainment
  museum: "museum",
  gallery: "gallery",
  artwork: "gallery",
  art: "gallery",
  arts_centre: "theatre",
  theatre: "theatre",
  cinema: "cinema",
  studio: "music",
  music: "music",
  musical_instrument: "music",
  nightclub: "nightclub",
  events_venue: "nightclub",

  // Craft trades (most rows are `poi:craft:*`; without value entries they
  // hit the `craft → hardware` Hammer fallback, which is wrong for trades
  // like photographer / winery / electrician).
  photographer: "attraction",
  electrician: "charging",
  plumber: "auto_repair",
  hvac: "auto_repair",
  electronics_repair: "auto_repair",
  carpenter: "hardware",
  metal_construction: "hardware",
  stonemason: "hardware",
  signmaker: "gallery",
  painter: "beauty",
  shoemaker: "shoes",
  watchmaker: "jewelry",
  jeweller: "jewelry",

  // Hotels & tourism
  hotel: "hotel",
  motel: "lodging",
  guest_house: "lodging",
  hostel: "lodging",
  lodging: "lodging",
  apartment: "lodging",
  information: "tourist_info",
  attraction: "attraction",
  viewpoint: "attraction",
  theme_park: "attraction",
  zoo: "attraction",
  aquarium: "attraction",
  camp_site: "camp",
  picnic_site: "camp",

  // Sports & leisure
  fitness_centre: "gym",
  sports_centre: "sports",
  sports: "sports",
  pitch: "sports",
  stadium: "sports",
  swimming_pool: "sports",
  ice_rink: "sports",
  amusement_arcade: "sports",
  horse_riding: "sports",
  golf_course: "golf",
  miniature_golf: "golf",
  bowling_alley: "bowling",
  dance: "music",
  marina: "marina",
  slipway: "marina",

  // Parks
  park: "park",
  garden: "park",
  playground: "park",
  dog_park: "park",
  nature_reserve: "park",
  national_park: "park",

  // Transit
  bus: "transit_bus",
  bus_stop: "transit_bus",
  bus_station: "transit_bus",
  railway: "transit_train",
  station: "transit_train",
  halt: "transit_train",
  subway: "transit_subway",
  train_station: "transit_train",
  airport: "airport",
  aerodrome: "airport",
  ferry_terminal: "marina",

  // Worship
  place_of_worship: "place_of_worship",
  church: "place_of_worship",
  chapel: "place_of_worship",
  monastery: "place_of_worship",
  synagogue: "place_of_worship",
  mosque: "place_of_worship",
  temple: "place_of_worship",
  shrine: "place_of_worship",

  // Civic & gov
  post: "post",
  post_office: "post",
  police: "police",
  fire_station: "fire_station",
  townhall: "government",
  courthouse: "lawyer",
  prison: "government",
  embassy: "government",
  social_facility: "community_centre",
  social_centre: "community_centre",
  community_centre: "community_centre",
  nursing_home: "community_centre",
  shelter: "community_centre",
  animal_shelter: "pet",
  animal_boarding: "pet",
  funeral_directors: "funeral",

  // Misc
  laundry: "shop",
  dry_cleaning: "shop",
  copyshop: "shop",
  tobacco: "tobacco",
  "e-cigarette": "tobacco",

  // Building classes (from vector tile `building` source-layer `class` property)
  residential: "home",
  house: "home",
  detached: "home",
  semidetached_house: "home",
  apartments: "home",
  terrace: "home",
  bungalow: "home",
  cabin: "home",
  houseboat: "home",
  dormitory: "home",

  // Top-level OSM key fallbacks — used when the FTS class is legacy-coarse
  // (`poi:amenity`) and carries no subclass value.
  amenity: "default",
  leisure: "park",
  healthcare: "clinic",
  tourism: "lodging",
  office: "office_generic",
  craft: "hardware",
  building: "default",
  default: "default",
};

/**
 * Parse an FTS class. Returns `null` for non-POI classes (`address`,
 * `postcode`, `place:*`); returns `{ key, value }` for
 * `poi:<key>[:<value>]`.
 */
export function parseFtsPoiClass(
  category: string | undefined | null,
): { key: string; value: string | null } | null {
  if (!category) return null;
  const raw = category.trim();
  if (!raw.startsWith("poi:")) return null;
  const segments = raw.split(":");
  const key = (segments[1] ?? "").trim();
  if (!key) return null;
  const value = segments.slice(2).join(":").trim();
  return { key, value: value.length > 0 ? value : null };
}

export function poiCategoryIconId(category: string | undefined | null): string | null {
  if (!category) return null;
  const direct = POI_CATEGORY_ICON[category];
  if (direct) return direct;
  const parsed = parseFtsPoiClass(category);
  if (!parsed) return null;
  return (
    POI_CATEGORY_ICON[parsed.value ?? ""] ??
    POI_CATEGORY_ICON[parsed.key] ??
    null
  );
}

const US_LABEL_OVERRIDES: Record<string, string> = {
  tyres: "Tires",
  theatre: "Theater",
  garden_centre: "Garden Center",
  arts_centre: "Arts Center",
  fitness_centre: "Fitness Center",
  sports_centre: "Sports Center",
  community_centre: "Community Center",
  social_centre: "Social Center",
};

export function formatPoiCategoryLabel(
  category: string | undefined | null,
  units: "metric" | "imperial" = "imperial",
): string {
  if (!category) return "";
  const parsed = parseFtsPoiClass(category);
  const source = parsed ? parsed.value || parsed.key : category;
  const normalized = source.trim().toLowerCase();
  if (!normalized) return "";
  if (units === "imperial" && normalized in US_LABEL_OVERRIDES) {
    return US_LABEL_OVERRIDES[normalized];
  }
  return normalized
    .split("_")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}
