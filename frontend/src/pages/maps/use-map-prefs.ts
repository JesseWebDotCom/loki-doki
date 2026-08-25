// Map preferences — localStorage-backed, single source of truth.
// Phase maps-discovery chunk-11.

import { useCallback, useEffect, useState } from "react";

const PREFIX = "maipai.maps.prefs.";

export interface MapPrefs {
  units: "metric" | "imperial";
  textSize: "small" | "medium" | "large";
  iconSize: "small" | "medium" | "large";
  showBuildingOutlines: boolean;
  showTrafficControls: boolean;
  showTerrain: boolean;
  showLandcover: boolean;
  autoDarkMode: "system" | "light" | "dark";
  northLock: boolean;
  showScaleBar: boolean;
  avoidTolls: boolean;
  avoidHighways: boolean;
  avoidFerries: boolean;
  hikingMaxRating: number;
  mtbMaxRating: number;
  showRoadHazards: boolean;
  showConstruction: boolean;
  showSpeedCameras: boolean;
  liveIncidents: boolean;
  // POI category visibility: key = category slug, value = enabled
  poiVisibility: Record<string, boolean>;
}

const DEFAULTS: MapPrefs = {
  units: "metric",
  textSize: "medium",
  iconSize: "medium",
  showBuildingOutlines: true,
  showTrafficControls: true,
  showTerrain: false,
  showLandcover: true,
  autoDarkMode: "system",
  northLock: false,
  showScaleBar: true,
  avoidTolls: false,
  avoidHighways: false,
  avoidFerries: false,
  hikingMaxRating: 4,
  mtbMaxRating: 5,
  showRoadHazards: true,
  showConstruction: true,
  showSpeedCameras: true,
  liveIncidents: false,
  poiVisibility: {},
};

function loadPrefs(): MapPrefs {
  try {
    const stored = localStorage.getItem(`${PREFIX}all`);
    if (stored) return { ...DEFAULTS, ...JSON.parse(stored) as Partial<MapPrefs> };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

// Same-tab broadcast: the `storage` event only fires in OTHER tabs, so without
// this every useMapPrefs() instance in this tab would drift after a setPref
// (e.g. the settings panel toggling terrain wouldn't reach the map's hook).
const PREFS_EVENT = "maipai-home:maps-prefs";

function savePrefs(prefs: MapPrefs): void {
  try { localStorage.setItem(`${PREFIX}all`, JSON.stringify(prefs)); } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(PREFS_EVENT)); } catch { /* ignore */ }
}

export function useMapPrefs(): {
  prefs: MapPrefs;
  setPref: <K extends keyof MapPrefs>(key: K, value: MapPrefs[K]) => void;
  resetPrefs: () => void;
} {
  const [prefs, setPrefs] = useState<MapPrefs>(loadPrefs);

  const setPref = useCallback(<K extends keyof MapPrefs>(key: K, value: MapPrefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      savePrefs(next);
      return next;
    });
  }, []);

  const resetPrefs = useCallback(() => {
    const fresh = { ...DEFAULTS };
    savePrefs(fresh);
    setPrefs(fresh);
  }, []);

  // Sync changes made in other tabs (storage) and other in-tab consumers (custom event).
  useEffect(() => {
    const handler = () => setPrefs(loadPrefs());
    window.addEventListener("storage", handler);
    window.addEventListener(PREFS_EVENT, handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener(PREFS_EVENT, handler);
    };
  }, []);

  return { prefs, setPref, resetPrefs };
}

export function isCategoryVisible(prefs: MapPrefs, slug: string): boolean {
  return prefs.poiVisibility[slug] !== false;
}
