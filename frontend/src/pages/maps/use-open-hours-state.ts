// Phase maps-discovery chunk-12: live open/closed icon state via feature-state.
// Uses pure-TS opening_hours evaluator (no opening_hours.js dependency).
// Updates POI icon colors every 60 seconds via map.setFeatureState().
import { useEffect, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";
import { evaluateOpeningHours } from "./opening-hours-eval";

const POI_SOURCE = "poi-overlay";
const INTERVAL_MS = 60_000;

function applyOpenState(map: maplibregl.Map): void {
  if (!map.getSource(POI_SOURCE)) return;
  const features = map.querySourceFeatures(POI_SOURCE, { filter: ["!", ["has", "point_count"]] });
  for (const f of features) {
    const oh = f.properties?.opening_hours as string | undefined;
    if (!oh || f.id == null) continue;
    const { isOpen } = evaluateOpeningHours(oh, new Date());
    map.setFeatureState({ source: POI_SOURCE, id: f.id }, { open: isOpen });
  }
}

export function useOpenHoursState(mapRef: MutableRefObject<maplibregl.Map | null>): void {
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const run = () => { if (map.isStyleLoaded()) applyOpenState(map); };
    run();
    const timer = window.setInterval(run, INTERVAL_MS);
    map.on("sourcedata", run);
    return (): void => {
      window.clearInterval(timer);
      map.off("sourcedata", run);
    };
  }, [mapRef]);
}
