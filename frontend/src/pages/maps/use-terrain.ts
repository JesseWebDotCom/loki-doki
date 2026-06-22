// Terrain (hillshade) layer hook.
//
// Adds a raster-dem source + MapLibre hillshade layer when the "Terrain
// hillshade" pref is on. The DEM is the OFFLINE per-region dem.pmtiles built
// alongside streets.pmtiles (terrarium-encoded) — derived from the active
// region's vector tile URL so it follows the user across regions with no
// network. Set VITE_TERRAIN_DEM_URL to override with an online raster-dem
// XYZ template instead (e.g. for development).

import { useEffect, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";
import { useMapPrefs } from "./use-map-prefs";

const DEM_SOURCE = "terrain-dem";
const HILLSHADE_LAYER = "terrain-hillshade";

function onlineDemUrl(): string | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
  return ((import.meta as any).env?.VITE_TERRAIN_DEM_URL as string | undefined) ?? null;
}

// Derive the offline DEM archive URL from the active region's vector source
// (pmtiles:///api/maps/tiles/<id>/streets.pmtiles → .../dem.pmtiles). Returns
// null when no region is active (overview/out-of-coverage) — no relief there.
function offlineDemUrl(map: maplibregl.Map): string | null {
  const region = map.getStyle().sources?.region as { url?: string } | undefined;
  const url = region?.url;
  if (!url || !url.includes("/streets.pmtiles")) return null;
  return url.replace("/streets.pmtiles", "/dem.pmtiles");
}

function addTerrainLayers(map: maplibregl.Map): void {
  if (map.getLayer(HILLSHADE_LAYER)) return;
  const online = onlineDemUrl();
  if (!map.getSource(DEM_SOURCE)) {
    // Cap requested maxzoom at 11 even though tiles exist to z13: hillshade over
    // a high-res DEM amplifies the elevation data's vertical quantization into
    // noisy "cloud" blotches, especially on flat terrain. Letting MapLibre
    // over-zoom (bilinear-upsample) an 11-ish DEM yields smooth relief instead.
    const common = { tileSize: 256, maxzoom: 11, encoding: "terrarium" as const };
    if (online) {
      map.addSource(DEM_SOURCE, { type: "raster-dem", tiles: [online], ...common });
    } else {
      const url = offlineDemUrl(map);
      if (!url) return; // no region / no DEM — nothing to shade
      map.addSource(DEM_SOURCE, { type: "raster-dem", url, ...common });
    }
  }
  // Insert below road layers so roads/labels stay crisp over the relief.
  const firstRoadLayer = map.getStyle().layers?.find((l) => l.id.startsWith("roads-"));
  map.addLayer(
    {
      id: HILLSHADE_LAYER,
      type: "hillshade",
      source: DEM_SOURCE,
      paint: {
        // Source is capped/upsampled (smooth), so exaggeration can stay high
        // without the cloudy noise. Kept visible across zooms — gentle terrain
        // (e.g. CT) needs the push; eased slightly up close so it doesn't muddy
        // dense streets.
        "hillshade-exaggeration": ["interpolate", ["linear"], ["zoom"], 7, 0.6, 11, 0.6, 14, 0.45],
        "hillshade-highlight-color": "rgba(255,255,255,0.20)",
        "hillshade-shadow-color": "rgba(0,0,0,0.32)",
        "hillshade-accent-color": "rgba(0,0,0,0)",
      },
    },
    firstRoadLayer?.id,
  );
}

function removeTerrainLayers(map: maplibregl.Map): void {
  if (map.getLayer(HILLSHADE_LAYER)) map.removeLayer(HILLSHADE_LAYER);
  if (map.getSource(DEM_SOURCE)) map.removeSource(DEM_SOURCE);
}

export function useTerrain(mapRef: MutableRefObject<maplibregl.Map | null>): void {
  const { prefs } = useMapPrefs();
  const showTerrain = prefs.showTerrain;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Re-apply on every styledata: setStyle() (theme / region change) wipes the
    // terrain source+layer, so this re-adds them with the now-active region's
    // DEM. Keeps terrain following the user across regions without re-plumbing.
    const apply = () => {
      const m = mapRef.current;
      if (!m) return;
      if (showTerrain) addTerrainLayers(m);
      else removeTerrainLayers(m);
    };
    if (map.isStyleLoaded()) apply();
    map.on("styledata", apply);
    return () => {
      map.off("styledata", apply);
      const m = mapRef.current;
      if (m) removeTerrainLayers(m);
    };
  }, [mapRef, showTerrain]);
}
