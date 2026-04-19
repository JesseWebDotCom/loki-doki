/**
 * Pure helpers for MapsSection — kept side-effect-free so vitest can
 * exercise them without jsdom or mocks. Covers tree flattening,
 * aggregate-size math, selection diffing, and install-phase label /
 * time-estimate helpers.
 */

export interface CatalogRegion {
  region_id: string;
  label: string;
  parent_id: string | null;
  center: { lat: number; lon: number };
  bbox: [number, number, number, number];
  sizes_mb: {
    street: number;
    valhalla: number;
    pbf: number;
  };
  downloadable: boolean;
  pi_local_build_ok: boolean;
  children?: CatalogRegion[];
}

export interface RegionSelection {
  street: boolean;
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
): { street: number; total: number } {
  let street = 0;
  for (const region of regions) {
    const s = selection[region.region_id];
    if (!s) continue;
    if (s.street) street += region.sizes_mb.street + region.sizes_mb.valhalla;
  }
  return { street, total: street };
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
 * flag changed. Used to decide which PUTs to fire on install.
 */
export function changedRegions(
  before: SelectionMap,
  after: SelectionMap,
): string[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const id of ids) {
    const a = before[id] ?? { street: false };
    const b = after[id] ?? { street: false };
    if (a.street !== b.street) out.push(id);
  }
  return out;
}

/**
 * Human label for the install-pipeline phase emitted by the backend.
 * Falls through to the raw phase string when unknown so the UI still
 * surfaces *something* meaningful even if the backend adds a phase.
 */
export function labelForPhase(phase: string): string {
  switch (phase) {
    case "downloading_pbf":
      return "Downloading OSM data";
    case "building_geocoder":
      return "Indexing addresses";
    case "building_streets":
      return "Building vector tiles";
    case "building_routing":
      return "Building road graph";
    case "complete":
      return "Done";
    default:
      return phase;
  }
}

/**
 * Rough human-readable time estimate for the long tippecanoe /
 * valhalla stages. Values are the Pi-5 timings from
 * ``docs/roadmap/maps-local-build/PLAN.md``'s footprint table —
 * conservative by design so users don't abandon mid-build.
 *
 * ``platform = "mac"`` multiplies by 0.3 to reflect the ~3× speedup
 * on m-series silicon; anything else assumes the worst-case Pi timing.
 */
export function estimateForPhase(
  phase: string,
  pbfSizeMb: number,
  platform: "mac" | "pi" | "unknown" = "unknown",
): string {
  const scale = platform === "mac" ? 0.3 : 1;
  let minutes = 0;
  if (phase === "building_streets") {
    // ~5 min for a small state (~25 MB PBF), ~20 min for ~300 MB.
    minutes = Math.max(2, Math.round((pbfSizeMb / 25) * 5));
  } else if (phase === "building_routing") {
    minutes = Math.max(3, Math.round((pbfSizeMb / 25) * 7));
  } else {
    return "";
  }
  const scaled = Math.max(1, Math.round(minutes * scale));
  return `~${scaled} min remaining`;
}
