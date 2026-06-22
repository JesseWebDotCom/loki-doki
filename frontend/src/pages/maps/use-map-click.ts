import { useEffect, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";

import { resolveHoverIdentity, resolveNamedClick } from "./hover";
import type { PlaceResult } from "./types";

interface Refs {
  selectedPoiRef: MutableRefObject<{ source: string; sourceLayer: string; id: string | number } | null>;
  poiCacheRef: MutableRefObject<Map<string, PlaceResult>>;
  clickSeqRef: MutableRefObject<number>;
}

interface Callbacks {
  onSelectPlace: (place: PlaceResult) => void;
  onClearSelection: () => void;
  onRecent: (place: PlaceResult) => void;
}

export function useMapClick(
  mapRef: MutableRefObject<maplibregl.Map | null>,
  refs: Refs,
  callbacks: Callbacks,
): void {
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const { selectedPoiRef, poiCacheRef, clickSeqRef } = refs;
    const { onSelectPlace, onClearSelection, onRecent } = callbacks;

    const onClick = (event: maplibregl.MapMouseEvent): void => {
      if (!map.isStyleLoaded()) return;
      const clickableLayers = ["poi-label", "buildings-2d", "buildings-3d"].filter(
        (id) => Boolean(map.getLayer(id)),
      );
      if (clickableLayers.length === 0) return;
      const feature = map.queryRenderedFeatures(event.point, { layers: clickableLayers })[0];
      if (!feature) return;

      if (selectedPoiRef.current) {
        try { map.setFeatureState(selectedPoiRef.current, { selected: false }); } catch { /* ignore */ }
      }
      if (feature.id !== undefined && feature.sourceLayer) {
        const ref = { source: feature.source, sourceLayer: feature.sourceLayer, id: feature.id };
        try { map.setFeatureState(ref, { selected: true }); } catch { /* ignore */ }
        selectedPoiRef.current = ref;
      } else {
        selectedPoiRef.current = null;
      }

      const tileHint = {
        class: typeof feature.properties?.class === "string" ? feature.properties.class : null,
        subclass: typeof feature.properties?.subclass === "string" ? feature.properties.subclass : null,
      };
      const lat = event.lngLat.lat;
      const lon = event.lngLat.lng;
      const tileName = typeof feature.properties?.name === "string" ? feature.properties.name.trim() : null;
      const prefetched = tileName ? poiCacheRef.current.get(tileName) ?? null : null;

      if (tileName) {
        const k = tileHint.subclass ?? tileHint.class ?? null;
        onSelectPlace(
          prefetched ?? {
            place_id: `tile:${lat.toFixed(6)},${lon.toFixed(6)}`,
            title: tileName, subtitle: "", address_lines: [], lat, lon,
            kind: k ?? undefined,
          },
        );
        onClearSelection();
      }

      const seq = ++clickSeqRef.current;
      const enrich = tileName
        ? resolveNamedClick(tileName, { lat, lon }, tileHint)
        : resolveHoverIdentity({ lat, lon, tileHint });
      void enrich.then((resolved) => {
        if (clickSeqRef.current !== seq || !resolved) return;
        onSelectPlace(resolved.place);
        if (tileName) poiCacheRef.current.set(tileName, resolved.place);
        onRecent(resolved.place);
      });
    };

    map.on("click", onClick);
    return () => { map.off("click", onClick); };
  }, [mapRef]); // eslint-disable-line react-hooks/exhaustive-deps
}
