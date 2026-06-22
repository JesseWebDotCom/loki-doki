/**
 * Proactively resolves visible POI labels on map idle so that
 * when the user clicks one the FTS result (name + address + category)
 * is already cached and the card shows it instantly.
 */
import { useEffect, useRef } from "react";
import type maplibregl from "maplibre-gl";

import { resolveByName } from "./hover";
import type { PlaceResult } from "./types";

const PREFETCH_DEBOUNCE_MS = 1500;
const PREFETCH_MAX = 10;

export function usePOIPrefetch(
  mapRef: React.RefObject<maplibregl.Map | null>,
): React.MutableRefObject<Map<string, PlaceResult>> {
  const cacheRef = useRef<Map<string, PlaceResult>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    function prefetch() {
      const m = mapRef.current;
      if (!m || !m.isStyleLoaded()) return;
      const center = m.getCenter();
      const near = { lat: center.lat, lon: center.lng };
      const features = m.queryRenderedFeatures(undefined, { layers: ["poi-label"] });
      const seen = new Set<string>();
      let count = 0;
      for (const f of features) {
        if (count >= PREFETCH_MAX) break;
        const name = typeof f.properties?.name === "string" ? f.properties.name.trim() : null;
        if (!name || seen.has(name) || cacheRef.current.has(name)) continue;
        seen.add(name);
        count++;
        void resolveByName(name, near).then((id) => {
          if (id) cacheRef.current.set(name, id.place);
        });
      }
    }

    function onIdle() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(prefetch, PREFETCH_DEBOUNCE_MS);
    }

    map.on("idle", onIdle);
    return () => {
      map.off("idle", onIdle);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [mapRef]); // eslint-disable-line react-hooks/exhaustive-deps

  return cacheRef;
}
