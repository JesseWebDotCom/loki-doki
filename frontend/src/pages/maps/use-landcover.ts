// Toggles the satellite landcover raster wash (region-landcover-raster, added
// in style-core) from the `showLandcover` pref. The layer always lives in the
// style; this just flips its visibility, re-applying after every setStyle
// (theme / region change wipes layout state).

import { useEffect, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";
import { useMapPrefs } from "./use-map-prefs";

const LAYER = "region-landcover-raster";

export function useLandcover(mapRef: MutableRefObject<maplibregl.Map | null>): void {
  const { prefs } = useMapPrefs();
  const show = prefs.showLandcover;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const m = mapRef.current;
      if (!m || !m.getLayer(LAYER)) return;
      m.setLayoutProperty(LAYER, "visibility", show ? "visible" : "none");
    };
    if (map.isStyleLoaded()) apply();
    map.on("styledata", apply);
    return () => { map.off("styledata", apply); };
  }, [mapRef, show]);
}
