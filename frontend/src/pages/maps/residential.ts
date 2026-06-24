import type { PlaceResult } from "./types";

// Shared "is this a home we can resolve / show an aerial for?" logic, used by
// both ResidentialDetails (property + resident lookup) and PlaceHeaderBanner
// (satellite snapshot hero). Keep the two in lock-step by sharing this module.

export interface ParsedAddress {
  house: string;
  street: string;
  city: string;
  state: string;
  zip?: string;
}

/** Pull house/street/city/state out of a clicked place, or null if it isn't an address. */
export function parsePlaceAddress(place: PlaceResult): ParsedAddress | null {
  const lines = [place.title, ...place.address_lines, place.subtitle]
    .map((l) => (l ?? "").trim())
    .filter(Boolean);

  // Street = first line beginning with a house number.
  const streetLine = lines.find((l) => /^\d+[A-Za-z]?(?:-\d+)?\s+\S/.test(l));
  if (!streetLine) return null;
  const sm = streetLine.match(/^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/);
  if (!sm) return null;
  const house = sm[1];
  // Drop a trailing ", City, ST ..." if the street line itself carried the locality.
  const street = sm[2].split(",")[0].trim();

  // City + state: the first line carrying a 2-letter state token.
  let city = "";
  let state = "";
  let zip: string | undefined;
  for (const l of lines) {
    const m = l.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\b[,\s]*(\d{5}(?:-\d{4})?)?/);
    if (m) {
      city = m[1].replace(/^\d+\s+\S.*?,\s*/, "").trim();
      state = m[2];
      zip = m[3];
      break;
    }
  }
  if (!city || !state) return null;
  return { house, street, city, state, zip };
}

/**
 * True when a place looks like a home (parseable street address, no business
 * website or attributes) — the same gate ResidentialDetails uses to decide
 * whether to run a property/resident lookup.
 */
export function isResidentialPlace(place: PlaceResult): boolean {
  return parsePlaceAddress(place) != null && !place.website && !place.business_attrs;
}
