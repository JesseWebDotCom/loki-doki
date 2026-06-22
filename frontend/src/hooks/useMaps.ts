/**
 * Maps data hooks (plain fetch — v3 does not use TanStack Query).
 *
 * `useInstalledMapRegions` powers the map page: it returns every region the
 * user has installed, with its install state, bbox and center. The map uses
 * `state.street_installed` to decide which regions have queryable tiles.
 */
import { useEffect, useState } from "react";

export interface MapRegionStateWire {
  region_id: string;
  street_installed: boolean;
  valhalla_installed: boolean;
  pbf_installed: boolean;
  geocoder_installed: boolean;
  openaddresses_installed: boolean;
  bytes_on_disk: Record<string, number>;
  installed_at: string | null;
  geocoder_schema_version: number;
  last_error: string | null;
}

export interface InstalledRegionRow {
  region_id: string;
  label: string;
  config: { region_id: string; street: boolean };
  state: MapRegionStateWire;
  bbox: [number, number, number, number];
  center: { lat: number; lon: number };
}

export function useInstalledMapRegions(): {
  data: InstalledRegionRow[] | undefined;
  loading: boolean;
  refetch: () => void;
} {
  const [data, setData] = useState<InstalledRegionRow[] | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/maps/regions", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: InstalledRegionRow[]) => {
        if (!cancelled) setData(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setData([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, refetch: () => setTick((t) => t + 1) };
}
