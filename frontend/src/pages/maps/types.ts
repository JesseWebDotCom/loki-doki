/**
 * Shared types for the Apple Maps-style rail and its panels.
 *
 * `PlaceResult` is the normalized shape every search backend (online
 * Nominatim now, offline FTS5 in Chunk 5) must converge on before
 * reaching the rail / card / recents code. Backends translate their
 * raw payloads into this shape in a single helper — no feature code
 * below touches provider-specific fields.
 */

export type ActivePanel = 'search' | 'guides' | 'directions' | null;

export interface PlaceResult {
  /** Stable id across providers. Nominatim's `place_id`, FTS5's rowid, etc. */
  place_id: string;
  /** Short display head — "123 Main St", "Hartford", "Central Park". */
  title: string;
  /** Muted tail — locality / region / country, already formatted for UI. */
  subtitle: string;
  /** Full address block, one line per component. */
  address_lines: string[];
  lat: number;
  lon: number;
  /** Category hint for zoom heuristics and icon choice ("city", "address", ...). */
  kind?: string;
}

export interface Recent extends PlaceResult {
  /** Epoch ms when the user last selected this place. */
  selected_at: number;
}
