/**
 * Shared POI category → sprite icon id map for the click-opened
 * PlaceDetailsCard and the hover-opened PoiHoverPreview. Keeps the
 * sprite contract in one place so both surfaces render the same icon
 * for a given feature class/subclass.
 */

const PLACE_ICON_IDS = new Set([
  'restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'grocery', 'shop',
  'convenience', 'pharmacy', 'bank', 'atm', 'gas', 'parking', 'school',
  'hospital', 'clinic', 'library', 'museum', 'hotel', 'lodging',
  'transit_bus', 'transit_train', 'transit_subway', 'airport', 'park',
  'place_of_worship', 'post', 'police', 'fire_station', 'default',
]);

export function poiCategoryIconId(category: string | undefined | null): string | null {
  if (!category) return null;
  return PLACE_ICON_IDS.has(category) ? category : null;
}
