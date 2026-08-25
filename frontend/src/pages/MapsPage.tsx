import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { MapPin } from "lucide-react";

// Register the pmtiles:// protocol so MapLibre can read offline vector-tile archives. Lives
// here (in the lazy Maps chunk) rather than main.tsx so maplibre-gl (~800KB) isn't hoisted into
// the entry bundle every session pays for. Runs once when this chunk first loads; guarded so
// HMR never double-registers.
if (!window.__maipaiPmtilesProtocolInstalled__) {
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  window.__maipaiPmtilesProtocolInstalled__ = true;
}
import { PageShell } from "@/components/shared/PageShell";
import { SpaceBackdrop } from "@/components/shared/SpaceBackdrop";

import { useInstalledMapRegions } from "@/hooks/useMaps";
import { useConnectivity } from "@/hooks/useConnectivity";
import { usePublishUIContext } from "@/context/UIContextProvider";
import { useAppHeader } from "@/context/BreadcrumbSearchContext";

import { reverseGeocode, type ViewportCenter } from "./maps/api";
import { usePOIPrefetch } from "./maps/use-poi-prefetch";
import { LayerModeChip } from "./maps/LayerModeChip";
import { LeftRail } from "./maps/LeftRail";
import { MapControls } from "./maps/MapControls";
import { installMissingImageLoader } from "./maps/missing-image-loader";
import { OutOfCoverageBanner, NoRegionsNotice } from "./maps/OutOfCoverageBanner";
import {
  FALLBACK_CENTER,
  buildRuntimeStyle,
  parseDeepLink,
  runtimeStyleKey,
} from "./maps/page-helpers";
import { useTerrain, useOpenHoursState } from "./maps/use-traffic-controls";
import { useLandcover } from "./maps/use-landcover";
import { useUserLocation } from "./maps/use-user-location";
import { toast } from "@/lib/toast";
import { useMapClick } from "./maps/use-map-click";
import { useGlobeSpin } from "./maps/use-globe-spin";
import { MapsPanelContent } from "./maps/MapsPanelContent";
import { PlaceDetailsCard } from "./maps/panels/PlaceDetailsCard";
import { PlaceHeaderBanner } from "./maps/panels/PlaceHeaderBanner";
import { SearchPanel } from "./maps/panels/SearchPanel";
import { loadStoredMapView, saveStoredMapView } from "./maps/map-state";
import { useSelectionMarker } from "./maps/use-selection-marker";
import { pushRecent } from "./maps/recents";
import {
  applyRoutes,
  applySelectedStep,
  boundsForAlts,
  clearRoutes,
  type RouteAltForLayer,
} from "./maps/route-layer";
import { fitMapToCoords } from "./maps/fit-coords";
import { chooseTileSource } from "./maps/tile-source";
import type { DeepLink, InstalledRegion, LayerMode, PanelKind, PlaceResult } from "./maps/types";
import type { RouteAlt } from "./maps/use-directions";
import { useMapTheme } from "./maps/use-map-theme";

// Once-per-session guard for the globe intro. Module scope (not storage) so it
// resets on a full reload but persists across in-app navigation back to Maps —
// "session" here means the app/tab lifetime, which is what we want.
let introPlayedThisSession = false;

export function MapsPage(): JSX.Element {
  const initialDeepLinkRef = useRef<DeepLink | null>(parseDeepLink(window.location.search));
  const storedViewRef = useRef(loadStoredMapView());
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tileUrlRef = useRef<string | null>(null);
  const styleKeyRef = useRef<string | null>(null);
  const previousModeRef = useRef<LayerMode>("map");
  const selectedPlaceRef = useRef<PlaceResult | null>(
    initialDeepLinkRef.current?.focusPlace
      ?? initialDeepLinkRef.current?.toPlace
      ?? storedViewRef.current?.selectedPlace
      ?? null,
  );
  const regionsRef = useRef<InstalledRegion[]>([]);
  const themeRef = useRef<"light" | "dark">("light");
  const layerModeRef = useRef<LayerMode>("map");
  const [activePanel, setActivePanel] = useState<PanelKind>(null);
  const [directionsTarget, setDirectionsTarget] = useState<PlaceResult | null>(null);
  const [directionsOrigin, setDirectionsOrigin] = useState<PlaceResult | null>(null);
  const [directionsMode, setDirectionsMode] = useState<"auto" | "pedestrian" | "bicycle" | "hiking" | "mtb">("auto");
  const [routeAlts, setRouteAlts] = useState<RouteAlt[]>([]);
  const [selectedAltIdx, setSelectedAltIdx] = useState(0);
  const [stepCoords, setStepCoords] = useState<[number, number][] | null>(null);
  const [layerMode, setLayerMode] = useState<LayerMode>("map");
  const connectivity = useConnectivity();
  const appMode   = connectivity?.appMode   ?? 'standard';
  const hasNetwork = connectivity?.hasNetwork ?? true;
  const [outOfCoverage, setOutOfCoverage] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(selectedPlaceRef.current);
  const [viewportCenter, setViewportCenter] = useState<ViewportCenter | null>(null);
  const [recentsReloadKey, setRecentsReloadKey] = useState(0);
  const [bearing, setBearing] = useState(0);
  // Globe view = zoomed far enough out that the planet (and the space scene
  // behind it) is visible. Drives the SpaceBackdrop mount.
  const [globeView, setGlobeView] = useState(false);
  const globeViewRef = useRef(false);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [deepLink] = useState<DeepLink | null>(initialDeepLinkRef.current);
  const [browseCategory, setBrowseCategory] = useState<string | null>(null);
  // Search query is owned here (not in SearchPanel) because the search INPUT
  // lives in the breadcrumb row per the app-header contract — see the
  // useAppHeader call below. The dock's SearchPanel renders the results.
  const [searchQuery, setSearchQuery] = useState(deepLink?.searchQuery ?? "");
  const selectedPoiRef = useRef<{ source: string; sourceLayer: string; id: string | number } | null>(null);
  const clickSeqRef = useRef(0);
  // True while the globe auto-rotation drives the camera — lets the moveend
  // handler skip its per-move work so we don't recompute tiles + write
  // localStorage 60×/sec while spinning.
  const spinningRef = useRef(false);
  const poiCacheRef = usePOIPrefetch(mapRef);
  useTerrain(mapRef);
  useLandcover(mapRef);
  useOpenHoursState(mapRef);

  // Apply deep-link state once on mount when both endpoints are provided.
  useEffect(() => {
    if (!deepLink) return;
    if (deepLink.fromPlace) setDirectionsOrigin(deepLink.fromPlace);
    if (deepLink.toPlace) setDirectionsTarget(deepLink.toPlace);
    if (deepLink.focusPlace) setSelectedPlace(deepLink.focusPlace);
    if (deepLink.mode) setDirectionsMode(deepLink.mode);
    if (deepLink.fromPlace && deepLink.toPlace) {
      setActivePanel("directions");
    }
    // Search is the rail's always-visible default — no setActivePanel
    // needed for deep-link search queries. Run once on mount; subsequent
    // state is owned by user actions.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    selectedPlaceRef.current = selectedPlace;
  }, [selectedPlace]);
  usePublishUIContext({
    label: "Maps",
    description: selectedPlace
      ? selectedPlace.subtitle
        ? `User is viewing the map — selected place: ${selectedPlace.title} (${selectedPlace.subtitle}).`
        : `User is viewing the map — selected place: ${selectedPlace.title}.`
      : "User is viewing the map.",
  });
  // Search + admin settings live in the breadcrumb row (app-header contract).
  // Live filtering, so no onSubmit — typing drives the dock's SearchPanel.
  // Selecting a place clears the box so its details replace the results.
  useAppHeader({
    query: searchQuery,
    setQuery: (q) => { setSearchQuery(q); if (q) setBrowseCategory(null); },
    placeholder: "Search places, addresses, ZIP…",
    settingsHref: "/maps/settings",
  });
  const { theme } = useMapTheme();
  const userLocation = useUserLocation();
  const installed = useInstalledMapRegions();
  const regions: InstalledRegion[] = useMemo(
    () => (installed.data ?? []).filter((row) => row.state.street_installed).map((row) => ({ region_id: row.region_id, label: row.label, bbox: row.bbox, center: row.center })),
    [installed.data],
  );
  const regionsLoaded = installed.data !== undefined;
  const hasRegions = regions.length > 0;
  const defaultCenter = regions[0]?.center ?? { lat: FALLBACK_CENTER[1], lon: FALLBACK_CENTER[0] };
  const initialTileSource = useMemo(() => chooseTileSource(regions, regions[0]?.center ?? { lat: FALLBACK_CENTER[1], lon: FALLBACK_CENTER[0] }), [regions]);
  if (tileUrlRef.current === null) {
    tileUrlRef.current = initialTileSource.tileUrl;
  }

  // Keep refs in sync so the moveend handler (bound once below) reads
  // fresh region/theme/mode values without forcing map recreation.
  useEffect(() => {
    regionsRef.current = regions;
  }, [regions]);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);
  useEffect(() => {
    layerModeRef.current = layerMode;
  }, [layerMode]);

  // Create the map exactly once. Theme / layerMode / region changes are
  // handled by the setStyle effect below — recreating the map on every
  // dependency change tears down in-flight tile/label requests
  // (NS_BINDING_ABORTED on world-labels.geojson) and burns WebGL
  // contexts.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }
    // When the once-per-session intro is still pending, open framed on the
    // globe (low zoom) regardless of where we'll land — the intro effect then
    // flies down to the real target. This guarantees the globe is the first
    // frame even if the dive's `load` timing slips.
    const introPending = !introPlayedThisSession;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        attributionControl: { compact: true },
        center: deepLink?.toPlace
          ? [deepLink.toPlace.lon, deepLink.toPlace.lat]
          : storedViewRef.current
            ? [storedViewRef.current.center.lon, storedViewRef.current.center.lat]
            : [defaultCenter.lon, defaultCenter.lat],
        zoom: introPending
          ? 1.4
          : deepLink?.toPlace
            ? 15
            : storedViewRef.current?.zoom ?? (regions.length ? 7 : 2),
        pitch: introPending ? 0 : layerMode === "3d" ? 55 : 0,
        style: buildRuntimeStyle(theme, initialTileSource.tileUrl, layerMode),
        renderWorldCopies: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setWebglError(msg.includes("WebGL") ? "WebGL is not available in this browser context." : msg);
      return;
    }
    styleKeyRef.current = runtimeStyleKey(theme, initialTileSource.tileUrl, layerMode);
    const uninstallMissingImageLoader = installMissingImageLoader(map);
    // Absorb benign MapLibre errors so they don't flood the console: in-flight
    // tile/glyph fetches get aborted when the map is torn down (React StrictMode
    // double-mount in dev, or navigating away), and sparse offline tilesets miss
    // some tiles. Without a listener MapLibre logs every one. Real errors warn.
    map.on("error", (e) => {
      const msg = (e as { error?: { message?: string } })?.error?.message ?? "";
      if (/abort|Failed to fetch|signal is aborted|NetworkError|404|Not Found/i.test(msg)) return;
      console.warn("[maps]", msg || e);
    });
    map.on("rotate", () => setBearing(map.getBearing()));
    // Toggle the space scene when crossing into / out of globe zoom. Only
    // setState on the transition so flyTo zoom frames don't churn renders.
    const GLOBE_VIEW_MAX = 3.6;
    const syncGlobeView = () => {
      const g = map.getZoom() <= GLOBE_VIEW_MAX;
      if (g !== globeViewRef.current) {
        globeViewRef.current = g;
        setGlobeView(g);
      }
    };
    map.on("zoom", syncGlobeView);
    syncGlobeView();
    map.on("moveend", () => {
      // Auto-rotation drives the camera every frame; skip the heavy per-move
      // work (and the localStorage write) while it spins.
      if (spinningRef.current) return;
      const center = map.getCenter();
      saveStoredMapView({
        center: { lat: center.lat, lon: center.lng },
        zoom: map.getZoom(),
        selectedPlace: selectedPlaceRef.current,
      });
      setViewportCenter({ lat: center.lat, lon: center.lng });
      const b = map.getBounds();
      const next = chooseTileSource(regionsRef.current, { lat: center.lat, lon: center.lng }, {
        minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth(),
      });
      setOutOfCoverage(next.outOfCoverage);
      if (next.tileUrl !== tileUrlRef.current) {
        tileUrlRef.current = next.tileUrl;
        const nextStyleKey = runtimeStyleKey(themeRef.current, next.tileUrl, layerModeRef.current);
        if (nextStyleKey !== styleKeyRef.current) {
          styleKeyRef.current = nextStyleKey;
          map.setStyle(buildRuntimeStyle(themeRef.current, next.tileUrl, layerModeRef.current));
        }
      }
    });
    mapRef.current = map;
    return () => {
      uninstallMissingImageLoader();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cinematic globe intro — once per session (app/tab lifetime). On the first
  // Maps open after a reload, pull the camera back to space (globe view) and
  // dive into wherever this entry would land: the deep-link target, the restored
  // last view, or the first installed region. Subsequent in-app opens jump
  // straight there; a full reload re-arms it.
  const introScheduledRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || introScheduledRef.current) return;
    if (introPlayedThisSession) {
      introScheduledRef.current = true;
      return;
    }
    // Pick the dive target: deep-link > restored view > first region.
    let target: { lon: number; lat: number; zoom: number } | null =
      deepLink?.toPlace
        ? { lon: deepLink.toPlace.lon, lat: deepLink.toPlace.lat, zoom: 15 }
        : storedViewRef.current
          ? { lon: storedViewRef.current.center.lon, lat: storedViewRef.current.center.lat, zoom: storedViewRef.current.zoom }
          : null;
    if (!target) {
      if (!regionsLoaded) return; // wait for installed regions to resolve
      if (!hasRegions) { introScheduledRef.current = true; introPlayedThisSession = true; return; }
      target = { lon: regions[0].center.lon, lat: regions[0].center.lat, zoom: 7 };
    }
    introScheduledRef.current = true;
    // Land on a clean map after the dive: don't auto-reopen the place that was
    // selected in a previous session (its marker + details would pop in and
    // replace the search/region panel). A deep-link to a specific place keeps it.
    if (!deepLink?.toPlace && !deepLink?.focusPlace) {
      setSelectedPlace(null);
    }
    const t = target;
    const dive = () => {
      // Bail if the map was torn down before `load` fired — under React
      // StrictMode the first mount is thrown away, and marking the session flag
      // here (not synchronously above) keeps the real second mount from skipping.
      if (!mapRef.current) return;
      introPlayedThisSession = true;
      // Frame the target from orbit, then descend with a gentle rotation.
      map.jumpTo({ center: [t.lon, t.lat], zoom: 1.4, bearing: -28, pitch: 0 });
      map.flyTo({
        center: [t.lon, t.lat],
        zoom: t.zoom,
        bearing: 0,
        pitch: layerModeRef.current === "3d" ? 55 : 0,
        duration: 4200,
        curve: 1.5,
        essential: true,
      });
    };
    if (map.loaded()) dive();
    else map.once("load", dive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionsLoaded, hasRegions]);

  // Idle auto-rotation of the globe view (pauses on manual gesture, resumes
  // after a quiet period). Declared after the map-creation effect so mapRef is
  // populated by the time this effect runs.
  useGlobeSpin(mapRef, spinningRef);

  useEffect(() => {
    if (!mapRef.current) return;
    const center = mapRef.current.getCenter();
    setViewportCenter({ lat: center.lat, lon: center.lng });
    const b = mapRef.current.getBounds();
    const next = chooseTileSource(regions, { lat: center.lat, lon: center.lng }, {
      minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth(),
    });
    setOutOfCoverage(next.outOfCoverage);
    tileUrlRef.current = next.tileUrl;
    const nextStyleKey = runtimeStyleKey(theme, next.tileUrl, layerMode);
    if (nextStyleKey === styleKeyRef.current) {
      return;
    }
    styleKeyRef.current = nextStyleKey;
    mapRef.current.setStyle(buildRuntimeStyle(theme, next.tileUrl, layerMode));
  }, [layerMode, regions, theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const previousMode = previousModeRef.current;
    if (previousMode === layerMode) return;
    previousModeRef.current = layerMode;
    const zoomDelta = 0.85;
    if (layerMode === "3d") {
      map.easeTo({
        pitch: 55,
        zoom: map.getZoom() + zoomDelta,
        duration: 350,
        essential: true,
      });
      return;
    }
    // "map" and "satellite" both use flat view; only compensate zoom if coming from 3d
    map.easeTo({
      pitch: 0,
      zoom: previousMode === "3d" ? Math.max(0, map.getZoom() - zoomDelta) : map.getZoom(),
      duration: 300,
      essential: true,
    });
  }, [layerMode]);

  // Auto-exit satellite when internet becomes unavailable (either reason)
  useEffect(() => {
    if (layerMode === 'satellite' && (appMode === 'local' || !hasNetwork)) setLayerMode('map');
  }, [appMode, hasNetwork, layerMode]);

  // Hide the place pin on the globe — keep the void clean. Selection state is
  // preserved, so the marker reappears once you've dived back in.
  useSelectionMarker(mapRef, globeView ? null : selectedPlace);

  // On the globe, pad the camera left by the dock width so the planet sits
  // centered in the visible map area rather than partly behind the panel.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const left = globeView && window.innerWidth >= 768 ? 400 : 0;
      map.setPadding({ top: 0, right: 0, bottom: 0, left });
    };
    // setPadding() is a jumpTo under the hood, so it stops any in-flight camera
    // animation. A flyTo diving in from the globe crosses the globe→map zoom
    // threshold, which flips globeView and re-runs this effect — applying padding
    // mid-flight would abort the dive half-way (the locate button's "stops at the
    // wrong zoom, click again to finish" bug). Defer to moveend while moving.
    if (map.isMoving()) {
      map.once("moveend", apply);
      return () => { map.off("moveend", apply); };
    }
    apply();
  }, [globeView]);

  // Render a live "you are here" dot wherever the browser reports the user.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const loc = userLocation.location;
    if (!loc) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      // design-ok(hex-in-tsx): user-location marker convention (blue dot), cartographic data akin to pages/maps/ allowlist
      el.style.cssText =
        "width:16px;height:16px;border-radius:9999px;background:#2563eb;" +
        "border:3px solid #fff;box-shadow:0 0 0 2px rgba(37,99,235,0.35),0 1px 4px rgba(0,0,0,0.4);";
      userMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([loc.lon, loc.lat]).addTo(map);
    } else {
      userMarkerRef.current.setLngLat([loc.lon, loc.lat]);
    }
  }, [userLocation.location]);

  // Locate button: fly to the user's location AND make it the active selection
  // (reverse-geocode for a real place; fall back to a generic "Your location").
  async function locateMe(): Promise<void> {
    const loc = userLocation.location;
    if (!loc) {
      if (userLocation.status === "denied") {
        toast.error("Location access is blocked — enable it in your browser settings.");
      } else if (userLocation.status === "unsupported") {
        toast.error("Location isn't available on this device.");
      } else {
        toast.info("Finding your location…");
      }
      return;
    }
    // Pass padding explicitly so the dive animates the globe's left:400 padding
    // back to 0 and lands the location centered (not shoved right behind the dock).
    mapRef.current?.flyTo({
      center: [loc.lon, loc.lat],
      zoom: 17,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      essential: true,
    });
    setActivePanel(null);
    let place: PlaceResult | null = null;
    try {
      place = await reverseGeocode(loc.lat, loc.lon, 0.1);
    } catch {
      /* no coverage / offline — fall back below */
    }
    setSelectedPlace(
      place ?? {
        place_id: `me:${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}`,
        title: "Your location",
        subtitle: "",
        address_lines: [],
        lat: loc.lat,
        lon: loc.lon,
      },
    );
  }

  // Paint route alternates + selected step on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const layerInput: RouteAltForLayer[] = routeAlts.map((alt) => ({
        coords: alt.coords,
        duration_s: alt.duration_s,
        distance_m: alt.distance_m,
        is_fastest: alt.is_fastest,
      }));
      if (layerInput.length === 0) {
        clearRoutes(map);
        return;
      }
      applyRoutes(map, layerInput, selectedAltIdx);
      applySelectedStep(map, stepCoords);
      const bounds = boundsForAlts(layerInput);
      if (bounds && !stepCoords) {
        fitMapToCoords(map, [bounds[0], bounds[1]]);
      } else if (stepCoords && stepCoords.length > 1) {
        fitMapToCoords(map, stepCoords);
      }
    };
    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once("styledata", apply);
    }
  }, [routeAlts, selectedAltIdx, stepCoords]);


  useMapClick(
    mapRef,
    { selectedPoiRef, poiCacheRef, clickSeqRef },
    {
      onSelectPlace: (place) => { setSelectedPlace(place); setSearchQuery(""); },
      onClearSelection: () => { setActivePanel(null); },
      onRecent: (place) => { pushRecent(place); setRecentsReloadKey((k) => k + 1); },
    },
  );

  function onSelectPlace(place: PlaceResult): void {
    setSelectedPlace(place);
    setActivePanel(null);
    setSearchQuery("");
    pushRecent(place);
    setRecentsReloadKey((k) => k + 1);
    const map = mapRef.current;
    if (map) {
      const currentZoom = map.getZoom();
      const inView = currentZoom >= 15 && map.getBounds().contains([place.lon, place.lat]);
      if (!inView) {
        map.flyTo({ center: [place.lon, place.lat], zoom: Math.max(currentZoom, 16), essential: true });
      }
    }
  }

  function onDeselectPlace(): void {
    setSelectedPlace(null);
    const map = mapRef.current;
    if (map && selectedPoiRef.current) {
      try { map.setFeatureState(selectedPoiRef.current, { selected: false }); } catch { /* ignore */ }
      selectedPoiRef.current = null;
    }
  }

  // design-ok(hex-in-tsx): panel color matched to basemap land hex from the maps style-spec, cartographic data
  // Same color family as the map background but one step elevated:
  // light land is #f5efe2 (warm parchment) → panel is a richer cream
  // dark land is #1f2832 (dark blue-grey) → panel is a lighter slate
  const panelBg = theme === "light" ? "#faf6ef" : "#28374a";

  if (webglError) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <MapPin className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">Maps unavailable</p>
          <p className="text-xs text-muted-foreground">
            Your browser could not initialize WebGL, which is required to render the map.
            Try opening the app in a standard browser window.
          </p>
        </div>
      </div>
    );
  }

  return (
    <PageShell className="h-full w-full">
    <section className="flex h-full w-full flex-col md:flex-row" data-testid="page-app-maps">
      {/* Narrow icon-only rail */}
      <LeftRail
        activePanel={activePanel}
        onPanelChange={(panel) => { onDeselectPlace(); setActivePanel(panel); }}
        theme={theme}
      />

      {/* Map fills all remaining space; panels overlay it */}
      {/* Map fills all remaining space — panels overlay it, never resize it */}
      <div className="relative flex min-w-0 flex-1 overflow-hidden bg-card md:h-full">
        {/* Space scene — sits behind the transparent globe canvas, only while
            zoomed out to the globe. */}
        {globeView ? <SpaceBackdrop className="z-0" /> : null}
        {/* Map canvas (above the backdrop; panels/controls layer above it) */}
        <div ref={containerRef} className="relative z-[1] h-full w-full" />

        {/* 2D / 3D chip — upper right */}
        <div className="absolute top-3 right-3 z-20">
          <LayerModeChip mode={layerMode} onChange={setLayerMode} appMode={appMode} hasNetwork={hasNetwork} />
        </div>
        {/* Zoom + compass — bottom right */}
        <MapControls
          bearing={bearing}
          onZoomIn={() => mapRef.current?.zoomIn()}
          onZoomOut={() => mapRef.current?.zoomOut()}
          onResetNorth={() => { mapRef.current?.resetNorth(); setBearing(0); }}
          onLocate={locateMe}
          onGlobe={() => {
            const map = mapRef.current;
            if (!map) return;
            const c = map.getCenter();
            // Long, gently-eased pull-back so the ascent to orbit reads as smooth.
            map.flyTo({
              center: [c.lng, c.lat],
              zoom: 1.4,
              pitch: 0,
              bearing: 0,
              duration: 2600,
              curve: 1.42,
              easing: (t) => 1 - Math.pow(1 - t, 3),
              essential: true,
            });
          }}
          locateActive={userLocation.status === "granted" && userLocation.location !== null}
        />

        {/* Single dock column — overlays left portion of map */}
        <div
          className="absolute left-0 top-0 bottom-0 z-10 hidden md:flex flex-col w-[400px] overflow-hidden"
          style={{ backgroundColor: panelBg, boxShadow: "4px 0 24px 0 rgba(0,0,0,0.28)" }}
        >
          {selectedPlace && !globeView && !searchQuery.trim() ? (
            <>
              <PlaceHeaderBanner place={selectedPlace} />
              <div className="flex-1 overflow-y-auto px-3 pb-6">
                <PlaceDetailsCard
                  place={selectedPlace}
                  onClose={onDeselectPlace}
                  onDirections={(place) => { setSelectedPlace(null); setDirectionsTarget(place); setActivePanel("directions"); }}
                  flat
                />
              </div>
            </>
          ) : (
            <div className="flex-1 overflow-y-auto flex flex-col gap-3 px-3 pt-3 pb-4">
              {regionsLoaded && !hasRegions
                ? <NoRegionsNotice />
                : outOfCoverage ? <OutOfCoverageBanner /> : null}
              {hasRegions && outOfCoverage ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    Installed regions
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {regions.map((r) => (
                      <button
                        key={r.region_id}
                        type="button"
                        onClick={() =>
                          mapRef.current?.flyTo({ center: [r.center.lon, r.center.lat], zoom: 11, essential: true })
                        }
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium hover:border-brand/40 hover:bg-brand/5 transition-colors"
                      >
                        <MapPin className="size-3 text-brand" />
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {searchQuery.trim() || activePanel === null ? (
                <SearchPanel
                  key={browseCategory ?? "__default__"}
                  viewportCenter={viewportCenter}
                  query={searchQuery}
                  initialCategory={searchQuery.trim() ? null : (browseCategory ?? deepLink?.searchCategory ?? null)}
                  onSelect={onSelectPlace}
                  recentsReloadKey={recentsReloadKey}
                />
              ) : (
                <MapsPanelContent
                  activePanel={activePanel}
                  mapRef={mapRef}
                  directionsTarget={directionsTarget}
                  directionsOrigin={directionsOrigin}
                  directionsMode={directionsMode}
                  viewportCenter={viewportCenter}
                  selectedPlace={selectedPlace}
                  recentsReloadKey={recentsReloadKey}
                  onCategorySelect={(slug) => { setBrowseCategory(slug); setSearchQuery(""); setActivePanel(null); }}
                  onCloseDirections={() => { setActivePanel(null); setRouteAlts([]); setSelectedAltIdx(0); setStepCoords(null); }}
                  onAltsChange={(alts, idx) => { setRouteAlts(alts); setSelectedAltIdx(idx); setStepCoords(null); }}
                  onStepFocus={(coords) => setStepCoords(coords)}
                  onPinSelect={(pin) => { if (mapRef.current) mapRef.current.flyTo({ center: [pin.lon, pin.lat], zoom: 15, essential: true }); }}
                  onPickDirections={(entry) => { setDirectionsOrigin(entry.from); setDirectionsTarget(entry.to); setDirectionsMode(entry.mode); setActivePanel("directions"); }}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </section>
    </PageShell>
  );
}
