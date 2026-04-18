/**
 * Pure helpers for MapsSection — kept side-effect-free so vitest can
 * exercise them without jsdom or mocks. Covers tree flattening,
 * aggregate-size math, and the satellite-requires-street validator.
 */

export interface CatalogRegion {
  region_id: string;
  label: string;
  parent_id: string | null;
  center: { lat: number; lon: number };
  bbox: [number, number, number, number];
  sizes_mb: {
    street: number;
    satellite: number;
    valhalla: number;
    pbf: number;
  };
  downloadable: boolean;
  pi_local_build_ok: boolean;
  children?: CatalogRegion[];
}

export interface RegionSelection {
  street: boolean;
  satellite: boolean;
}

export type SelectionMap = Record<string, RegionSelection>;

/**
 * Depth-first flatten of a nested region tree. Parents come before
 * children — this ordering is what the admin panel uses to render
 * indented rows.
 */
export function flattenTree(roots: CatalogRegion[]): CatalogRegion[] {
  const out: CatalogRegion[] = [];
  const walk = (node: CatalogRegion) => {
    out.push(node);
    (node.children ?? []).forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/**
 * Sum of selected artifact sizes (in MB) across every region. The
 * running-total pill in the admin panel calls this on every checkbox
 * toggle.
 */
export function aggregateSize(
  regions: CatalogRegion[],
  selection: SelectionMap,
): { street: number; satellite: number; total: number } {
  let street = 0;
  let satellite = 0;
  for (const region of regions) {
    const s = selection[region.region_id];
    if (!s) continue;
    if (s.street) street += region.sizes_mb.street + region.sizes_mb.valhalla;
    if (s.satellite) satellite += region.sizes_mb.satellite;
  }
  return { street, satellite, total: street + satellite };
}

/**
 * Returns the first region_id that violates satellite-requires-street,
 * or ``null`` if the selection is internally consistent.
 */
export function validateSelection(selection: SelectionMap): string | null {
  for (const [regionId, sel] of Object.entries(selection)) {
    if (sel.satellite && !sel.street) return regionId;
  }
  return null;
}

/**
 * Format bytes with a unit label. Mirrors the archives panel's ``fmt``
 * so the visual language stays consistent.
 */
export function formatMB(mb: number): string {
  if (mb === 0) return "0 MB";
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Diff two selection maps and return the region ids whose ``street``
 * or ``satellite`` flag changed. Used to decide which PUTs to fire
 * on install.
 */
export function changedRegions(
  before: SelectionMap,
  after: SelectionMap,
): string[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const id of ids) {
    const a = before[id] ?? { street: false, satellite: false };
    const b = after[id] ?? { street: false, satellite: false };
    if (a.street !== b.street || a.satellite !== b.satellite) out.push(id);
  }
  return out;
}
