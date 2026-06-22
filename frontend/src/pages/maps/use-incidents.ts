// Phase maps-discovery chunk-15: 511 road incidents polling hook.
// Only active when the user has enabled "Live road incidents" in map settings.
// Polls GET /api/maps/incidents?state=<code> every 5 minutes.
import { useEffect, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";

const SOURCE = "incidents-511";
const LAYER = "incidents-511-circles";
const POLL_MS = 5 * 60 * 1000;

function detectStateCode(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const map: Record<string, string> = {
      "America/Los_Angeles": "CA", "America/New_York": "NY",
      "America/Chicago": "TX", "America/Denver": "CO",
      "America/Phoenix": "AZ", "America/Detroit": "OH",
      "America/Seattle": "WA",
    };
    return map[tz] ?? "CA";
  } catch { return "CA"; }
}

async function fetchIncidents(state: string): Promise<object> {
  const resp = await fetch(`/api/maps/incidents?state=${state}`);
  if (!resp.ok) throw new Error(`incidents ${resp.status}`);
  return resp.json() as Promise<object>;
}

export function useIncidents(
  mapRef: MutableRefObject<maplibregl.Map | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const map = mapRef.current;
    if (!map) return;
    const state = detectStateCode();

    async function refresh(): Promise<void> {
      const m = mapRef.current;
      if (!m || !m.isStyleLoaded()) return;
      try {
        const fc = await fetchIncidents(state);
        const src = m.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
        if (src) {
          src.setData(fc as GeoJSON.FeatureCollection);
        } else {
          m.addSource(SOURCE, { type: "geojson", data: fc as GeoJSON.FeatureCollection });
          m.addLayer({
            id: LAYER, type: "circle", source: SOURCE,
            paint: { "circle-radius": 8, "circle-color": "#ef4444", "circle-opacity": 0.8, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
          });
        }
      } catch { /* network unavailable — silently skip */ }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return (): void => {
      window.clearInterval(timer);
      const m2 = mapRef.current;
      if (m2?.getLayer(LAYER)) m2.removeLayer(LAYER);
      if (m2?.getSource(SOURCE)) m2.removeSource(SOURCE);
    };
  }, [mapRef, enabled]);
}
