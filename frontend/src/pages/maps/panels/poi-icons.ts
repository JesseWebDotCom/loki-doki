/**
 * Shared POI category → sprite icon id map for the click-opened
 * PlaceDetailsCard and the hover-opened PoiHoverPreview. Keeps the
 * sprite contract in one place so both surfaces render the same icon
 * for a given feature class/subclass.
 */

const CATEGORY_ICON_ID: Record<string, string> = {
  restaurant: 'restaurant',
  cafe: 'cafe',
  fast_food: 'fast_food',
  food_court: 'fast_food',
  bar: 'bar',
  pub: 'pub',
  grocery: 'grocery',
  supermarket: 'grocery',
  shop: 'shop',
  mall: 'shop',
  convenience: 'convenience',
  pharmacy: 'pharmacy',
  bank: 'bank',
  atm: 'atm',
  fuel: 'gas',
  gas: 'gas',
  parking: 'parking',
  school: 'school',
  college: 'school',
  university: 'school',
  hospital: 'hospital',
  clinic: 'clinic',
  doctors: 'clinic',
  dentist: 'clinic',
  library: 'library',
  museum: 'museum',
  hotel: 'hotel',
  motel: 'lodging',
  guest_house: 'lodging',
  hostel: 'lodging',
  lodging: 'lodging',
  bus: 'transit_bus',
  bus_stop: 'transit_bus',
  railway: 'transit_train',
  station: 'transit_train',
  halt: 'transit_train',
  subway: 'transit_subway',
  train_station: 'transit_train',
  airport: 'airport',
  aerodrome: 'airport',
  park: 'park',
  playground: 'park',
  place_of_worship: 'place_of_worship',
  post: 'post',
  post_office: 'post',
  police: 'police',
  fire_station: 'fire_station',
  default: 'default',
};

export function poiCategoryIconId(category: string | undefined | null): string | null {
  if (!category) return null;
  return CATEGORY_ICON_ID[category] ?? null;
}

export function formatPoiCategoryLabel(category: string | undefined | null): string {
  if (!category) return '';
  const normalized = category.trim().toLowerCase();
  if (!normalized) return '';
  return normalized
    .split('_')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}
