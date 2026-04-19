/**
 * MapsPage — Apple Maps-style two-pane layout (Chunk 4).
 *
 * Takes over the whole viewport like the Admin panel — no global app
 * Sidebar. The Maps LeftRail owns navigation and surfaces a
 * "Back to Chat" link at the footer.
 *
 * Left column (320px): `LeftRail` with brand + Search/Guides/Directions
 * nav + Recents + footer link to Settings → Maps + Back-to-Chat.
 *
 * Right column (1fr): the map surface. MapLibre renders the vector
 * basemap via the `pmtiles://` protocol; the tile-source resolver picks
 * between a local installed region and the online Protomaps demo.
 * Active panels (SearchPanel / PlaceDetailsCard / GuidesPanel /
 * DirectionsPanel) are pinned as a 360px sheet at the map's top-left
 * so the rail nav stays visible alongside.
 *
 * Place selection flow: SearchPanel → onSelect(place) → MapsPage drops
 * a pin, flies the map, pushes to `recents`, and shows PlaceDetailsCard.
 * Clicking the blue Directions button flips activePanel to
 * `directions`, which mounts DirectionsPanel (Chunk 7). A URL deep
 * link of the form /maps?from=lat,lon&to=lat,lon&mode=auto opens the
 * Directions panel pre-filled so skills can hand off to the UI.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { Download, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { buildDarkStyle, type ColorTheme, type LayerMode } from './maps/style-dark';
import LayerModeChip from './maps/LayerModeChip';
import {
  fetchInstalledRegions,
  resolveTileSource,
  type InstalledRegion,
  type ResolveResult,
} from './maps/tile-source';
import OutOfCoverageBanner from './maps/OutOfCoverageBanner';
import LeftRail from './maps/LeftRail';
import SearchPanel from './maps/panels/SearchPanel';
import PlaceDetailsCard from './maps/panels/PlaceDetailsCard';
import GuidesPanel from './maps/panels/GuidesPanel';
import DirectionsPanel from './maps/panels/DirectionsPanel';
import type {
  ModeId,
  RouteAlt,
} from './maps/panels/DirectionsPanel.types';
import {
  applyRoutes,
  boundsForAlts,
  clearRoutes,
} from './maps/route-layer';
import { MANAGE_MAPS_ROUTE } from './maps/routes';
import { loadRecents, pushRecent } from './maps/recents';
import type { ActivePanel, PlaceResult, Recent } from './maps/types';
import { useDocumentTitle } from '../lib/useDocumentTitle';

// Register the pmtiles:// protocol globally, once per module load.
// Guarded so Vite HMR doesn't stack duplicate handlers (MapLibre throws
// if the same protocol is added twice).
declare global {
  interface Window { __ldPmtilesRegistered?: boolean }
}
if (typeof window !== 'undefined' && !window.__ldPmtilesRegistered) {
  maplibregl.addProtocol('pmtiles', new Protocol().tile);
  window.__ldPmtilesRegistered = true;
}

// Dark-theme override for MapLibre's default popup + controls.
const MAPLIBRE_DARK_CSS = `
.maplibregl-popup { max-width: 320px; }
.maplibregl-popup-content {
  background: hsl(220 15% 14%) !important;
  color: hsl(210 20% 92%) !important;
  border: 1px solid hsl(220 10% 28%) !important;
  border-radius: 10px !important;
  padding: 10px 14px !important;
  font-size: 12px;
  line-height: 1.4;
  box-shadow: 0 6px 24px -8px rgba(0,0,0,0.6);
}
.maplibregl-popup-close-button {
  color: hsl(210 20% 70%) !important;
  font-size: 18px;
  padding: 0 6px;
}
.maplibregl-popup-tip {
  border-top-color: hsl(220 15% 14%) !important;
  border-bottom-color: hsl(220 15% 14%) !important;
}
.maplibregl-ctrl-group {
  background: hsl(220 15% 14%) !important;
  border: 1px solid hsl(220 10% 28%) !important;
}
.maplibregl-ctrl-group button {
  background-color: transparent !important;
}
.maplibregl-ctrl-group button span {
  filter: invert(90%);
}
.maplibregl-ctrl-group button:hover {
  background-color: hsl(220 15% 20%) !important;
}
.maplibregl-ctrl-attrib {
  background: rgba(20, 22, 28, 0.7) !important;
  color: hsl(210 15% 70%) !important;
}
.maplibregl-ctrl-attrib a {
  color: hsl(210 60% 72%) !important;
}
`;
if (typeof document !== 'undefined' && !document.getElementById('ld-maplibre-dark')) {
  const style = document.createElement('style');
  style.id = 'ld-maplibre-dark';
  style.textContent = MAPLIBRE_DARK_CSS;
  document.head.appendChild(style);
}

// ── Component ──────────────────────────────────────────────────

const MapsPage: React.FC = () => {
  useDocumentTitle('Maps');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const hoverMarkerRef = useRef<Marker | null>(null);

  const deepLink = useMemo(() => parseDeepLink(), []);
  const [activePanel, setActivePanel] = useState<ActivePanel>(
    deepLink ? 'directions' : 'search',
  );
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(
    deepLink?.toPlace ?? null,
  );
  const [directionsFromPlace, setDirectionsFromPlace] = useState<PlaceResult | null>(
    deepLink?.fromPlace ?? null,
  );
  const [directionsMode] = useState<ModeId>(deepLink?.mode ?? 'auto');
  const [recents, setRecents] = useState<Recent[]>(() => loadRecents());
  const [railCollapsed, setRailCollapsed] = useState(false);

  const [routeAlts, setRouteAlts] = useState<RouteAlt[]>([]);
  const [routeSelectedIdx, setRouteSelectedIdx] = useState(0);

  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState('');

  // Layer mode — flat ``map`` or ``3d`` (fill-extrusion buildings).
  // Flipping to 3D auto-pitches the camera; flipping back resets pitch
  // iff the user hasn't tilted it themselves in the meantime.
  const [mode, setMode] = useState<LayerMode>('map');

  // Track the active app theme so the map palette follows dark/light.
  // ThemeProvider toggles the ``dark`` class on <html>; MutationObserver
  // keeps us in sync when the user flips the theme while the map is open.
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() =>
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setColorTheme(root.classList.contains('dark') ? 'dark' : 'light');
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Coverage resolution — carried over from Chunk 3.
  const [regions, setRegions] = useState<InstalledRegion[]>([]);
  const [regionsLoaded, setRegionsLoaded] = useState(false);
  const [resolution, setResolution] = useState<ResolveResult | null>(null);
  const [viewportCenter, setViewportCenter] = useState<{ lng: number; lat: number } | null>(null);
  const regionsRef = useRef<InstalledRegion[]>([]);
  // "Use online preview anyway" dismissal — session-scoped so the
  // empty state returns on next page load until a region is installed.
  const [emptyAck, setEmptyAck] = useState(false);

  // ── Initialize the map ───────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let ro: ResizeObserver | null = null;
    let removeCtxListeners: (() => void) | null = null;

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: { version: 8, sources: {}, layers: [] },
        center: [-98.5, 39.8],
        zoom: 3,
        attributionControl: { compact: true },
      });
    } catch (exc) {
      setMapError(
        exc instanceof Error
          ? `Map init failed: ${exc.message}`
          : 'Map init failed',
      );
      return;
    }

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      'top-right',
    );
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
      }),
      'top-right',
    );

    map.on('load', () => {
      setMapReady(true);
      map.resize();
    });
    map.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.warn('MapLibre error', e);
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      setViewportCenter({ lng: c.lng, lat: c.lat });
      void resolveTileSource({ lng: c.lng, lat: c.lat }, regionsRef.current)
        .then((next) => {
          // Skip redundant updates. `setStyle` re-paints the entire
          // canvas, so if the tile source hasn't actually changed we
          // must NOT rebuild — otherwise every moveend flashes tiles
          // back to blank while they re-decode.
          setResolution((prev) => {
            if (prev && prev.kind === next.kind) {
              if (prev.kind === 'local' && next.kind === 'local') {
                if (prev.region === next.region) return prev;
              } else if (prev.kind === 'online' && next.kind === 'online') {
                if (prev.streetUrl === next.streetUrl) return prev;
              } else if (prev.kind === 'none' && next.kind === 'none') {
                return prev;
              }
            }
            return next;
          });
        });
    });

    const canvas = map.getCanvas();
    const onCtxLost = (e: Event) => {
      e.preventDefault();
      setMapError('Map context lost — reloading tiles…');
    };
    const onCtxRestored = () => {
      setMapError('');
      map.triggerRepaint();
    };
    canvas.addEventListener('webglcontextlost', onCtxLost);
    canvas.addEventListener('webglcontextrestored', onCtxRestored);
    removeCtxListeners = () => {
      canvas.removeEventListener('webglcontextlost', onCtxLost);
      canvas.removeEventListener('webglcontextrestored', onCtxRestored);
    };

    mapRef.current = map;

    ro = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    ro.observe(container);

    let cancelled = false;
    (async () => {
      const fetched = await fetchInstalledRegions();
      if (cancelled) return;
      regionsRef.current = fetched;
      setRegions(fetched);
      setRegionsLoaded(true);
      const initial = await resolveTileSource(undefined, fetched);
      if (cancelled) return;
      setResolution(initial);
      // Auto-fit to the first installed region's bbox (unless the user
      // arrived via a deep link that already specifies a location). The
      // map is initialised centered on the US at zoom 3 — without this
      // jump the initial viewport sits outside every installed bbox and
      // tile panning near the coverage edge churns the source.
      if (!deepLink && fetched.length > 0 && mapRef.current) {
        const [minLon, minLat, maxLon, maxLat] = fetched[0].bbox;
        mapRef.current.fitBounds(
          [[minLon, minLat], [maxLon, maxLat]],
          { padding: 40, duration: 0, maxZoom: 12 },
        );
      }
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      removeCtxListeners?.();
      markerRef.current?.remove();
      markerRef.current = null;
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // ── Apply the current tile source as a style swap ────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !resolution) return;

    if (resolution.kind === 'none') {
      map.setStyle({
        version: 8,
        sources: {},
        layers: [
          {
            id: 'bg',
            type: 'background',
            paint: { 'background-color': '#141519' },
          },
        ],
      });
      return;
    }

    map.setStyle(buildDarkStyle(resolution.streetUrl, { mode, theme: colorTheme }));
  }, [resolution, mode, colorTheme]);

  // ── Auto-pitch when flipping layer mode ──────────────────────
  // Flat ➜ 3D with a pitch of 0 gets a one-time 45° nudge so the
  // extrusions read as buildings. 3D ➜ flat resets pitch only if
  // the user left it at the nudge value — respecting manual tilt.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (mode === '3d') {
      if (map.getPitch() === 0) {
        map.easeTo({ pitch: 45, duration: 600 });
      }
    } else if (map.getPitch() !== 0) {
      map.easeTo({ pitch: 0, duration: 600 });
    }
  }, [mapReady, mode]);

  // ── Place selection ──────────────────────────────────────────
  const pinAndFly = useCallback((place: PlaceResult) => {
    const map = mapRef.current;
    if (!map) return;

    markerRef.current?.remove();
    markerRef.current = new maplibregl.Marker({ color: '#a855f7' })
      .setLngLat([place.lon, place.lat])
      .setPopup(new maplibregl.Popup({ offset: 25 }).setText(place.title))
      .addTo(map);
    markerRef.current.togglePopup();

    const zoom =
      place.kind === 'country' ? 4 :
      place.kind === 'state' || place.kind === 'administrative' ? 7 :
      place.kind === 'city' || place.kind === 'town' ? 11 :
      place.kind === 'postcode' ? 13 :
      16;

    map.flyTo({ center: [place.lon, place.lat], zoom, speed: 1.5, curve: 1.6 });
  }, []);

  const handleSelect = useCallback((place: PlaceResult) => {
    pinAndFly(place);
    hoverMarkerRef.current?.remove();
    hoverMarkerRef.current = null;
    setSelectedPlace(place);
    setRecents(pushRecent(place));
    setActivePanel(null);
  }, [pinAndFly]);

  const handleHover = useCallback((place: PlaceResult | null) => {
    const map = mapRef.current;
    if (!map) return;
    hoverMarkerRef.current?.remove();
    hoverMarkerRef.current = null;
    if (place) {
      hoverMarkerRef.current = new maplibregl.Marker({
        color: '#c4b5fd',
        scale: 0.7,
      })
        .setLngLat([place.lon, place.lat])
        .addTo(map);
    }
  }, []);

  const handleSelectRecent = useCallback((place: PlaceResult) => {
    pinAndFly(place);
    setSelectedPlace(place);
    setRecents(pushRecent(place));
    setActivePanel(null);
  }, [pinAndFly]);

  const handleDirections = useCallback((_place: PlaceResult) => {
    setActivePanel('directions');
  }, []);

  const handleRoutesChanged = useCallback(
    (alts: RouteAlt[], selectedIdx: number) => {
      setRouteAlts(alts);
      setRouteSelectedIdx(selectedIdx);
    },
    [],
  );

  const handleFitToCoords = useCallback((coords: [number, number][]) => {
    const map = mapRef.current;
    if (!map || coords.length === 0) return;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    map.fitBounds(
      [[minLng, minLat], [maxLng, maxLat]],
      { padding: 80, duration: 600, maxZoom: 17 },
    );
  }, []);

  const handleSelectPanel = useCallback((panel: Exclude<ActivePanel, null>) => {
    setActivePanel(panel);
    if (panel !== 'directions') {
      // Leaving directions back to search / guides clears the details
      // card so the new panel isn't dueling with PlaceDetailsCard.
      setSelectedPlace(null);
    }
  }, []);

  const closePanel = useCallback(() => {
    setActivePanel(null);
    setSelectedPlace(null);
    setDirectionsFromPlace(null);
    setRouteAlts([]);
    setRouteSelectedIdx(0);
    markerRef.current?.remove();
    markerRef.current = null;
    hoverMarkerRef.current?.remove();
    hoverMarkerRef.current = null;
    const map = mapRef.current;
    if (map && mapReady) {
      try { clearRoutes(map); } catch { /* style swap can race */ }
    }
  }, [mapReady]);

  // Apply route alts + selection to the map whenever they change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (routeAlts.length === 0) {
      try { clearRoutes(map); } catch { /* style swap race */ }
      return;
    }
    try {
      applyRoutes(
        map,
        routeAlts.map((a) => ({
          coords: a.coords,
          duration_s: a.duration_s,
          distance_m: a.distance_m,
          is_fastest: a.is_fastest,
        })),
        routeSelectedIdx,
      );
      // First paint after alternates arrive → fit to the union bounds.
      if (routeSelectedIdx === 0) {
        const bounds = boundsForAlts(routeAlts);
        if (bounds) {
          map.fitBounds(bounds, { padding: 80, duration: 600, maxZoom: 15 });
        }
      }
    } catch {
      // Safe no-op if the style swap is mid-flight.
    }
  }, [mapReady, routeAlts, routeSelectedIdx]);

  // Choose which panel body to render inside the floating sheet.
  const panelBody = useMemo(() => {
    if (activePanel === 'directions') {
      return (
        <DirectionsPanel
          toPlace={selectedPlace}
          fromPlace={directionsFromPlace}
          initialMode={directionsMode}
          viewportCenter={viewportCenter}
          onClose={closePanel}
          onRoutesChanged={handleRoutesChanged}
          onFitToCoords={handleFitToCoords}
        />
      );
    }
    if (selectedPlace) {
      return (
        <PlaceDetailsCard
          place={selectedPlace}
          onDirections={handleDirections}
          onClose={closePanel}
        />
      );
    }
    if (activePanel === 'search') {
      return (
        <SearchPanel
          viewportCenter={viewportCenter}
          onSelect={handleSelect}
          onHover={handleHover}
          onClose={closePanel}
        />
      );
    }
    if (activePanel === 'guides') {
      return <GuidesPanel onClose={closePanel} />;
    }
    return null;
  }, [
    activePanel,
    selectedPlace,
    directionsFromPlace,
    directionsMode,
    viewportCenter,
    handleSelect,
    handleHover,
    handleDirections,
    handleRoutesChanged,
    handleFitToCoords,
    closePanel,
  ]);

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <LeftRail
        active={activePanel}
        onSelectPanel={handleSelectPanel}
        recents={recents}
        onSelectRecent={handleSelectRecent}
        collapsed={railCollapsed}
        onToggleCollapsed={() => setRailCollapsed((v) => !v)}
      />

      <main className="flex-1 relative min-w-0 h-screen">
          {/* Map canvas */}
          <div
            ref={containerRef}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              background: '#1a1d22',
            }}
          />

          {regionsLoaded && regions.length === 0 && !emptyAck && (
            <NoRegionsEmptyState onContinue={() => setEmptyAck(true)} />
          )}

          {/* Floating panel sheet — lives inside the map surface, pinned
              to the top-left corner. Mirrors Apple Maps' inline sheet. */}
          {panelBody && (
            <div className="absolute left-4 top-4 z-10 w-[360px] max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-border/30 bg-card/95 backdrop-blur shadow-m4 flex flex-col">
              {panelBody}
            </div>
          )}

          {/* Out-of-coverage banner */}
          {resolution?.kind === 'none' && (
            <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 pointer-events-none">
              <OutOfCoverageBanner />
            </div>
          )}

          {/* Map status pills */}
          {mapError && (
            <div className="absolute bottom-12 left-4 z-10 pointer-events-none rounded-full bg-destructive/90 backdrop-blur px-3 py-1.5 text-[10px] text-destructive-foreground w-fit">
              {mapError}
            </div>
          )}
          {!mapReady && !mapError && (
            <div className="absolute bottom-12 left-4 z-10 pointer-events-none rounded-full bg-card/90 backdrop-blur px-3 py-1.5 text-[10px] text-muted-foreground w-fit">
              Loading map…
            </div>
          )}

        {/* Layer-mode chip — top-right beneath the MapLibre controls. */}
        <div className="absolute top-28 right-3 z-10">
          <LayerModeChip mode={mode} onChange={setMode} />
        </div>

        {/* Attribution pill */}
        <div className="absolute bottom-4 left-4 z-10 pointer-events-none">
          <div className="rounded-full bg-card/80 backdrop-blur px-3 py-1 text-[10px] text-muted-foreground flex items-center gap-1.5">
            <MapPin size={10} />
            OpenStreetMap · Nominatim
          </div>
        </div>
      </main>
    </div>
  );
};

// ── Empty state ────────────────────────────────────────────────────

const NoRegionsEmptyState: React.FC<{ onContinue: () => void }> = ({
  onContinue,
}) => (
  <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/85 backdrop-blur-sm">
    <div className="mx-6 flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border/40 bg-card/95 p-8 text-center shadow-m4">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-primary">
        <MapPin size={26} />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">
          No offline regions installed
        </h2>
        <p className="text-sm text-muted-foreground">
          LokiDoki Maps is designed for offline use. Install at least one
          region to search, route, and render tiles without an internet
          connection.
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        <Link
          to={MANAGE_MAPS_ROUTE}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-m2 transition-colors hover:bg-primary/90"
        >
          <Download size={14} />
          Install a region
        </Link>
        <button
          type="button"
          onClick={onContinue}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-border/40 bg-card/60 px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground/80">
        First install downloads ~25 MB for a small state, then builds tiles
        on-device (2–8 min). No internet needed after.
      </p>
    </div>
  </div>
);

// ── Deep link parsing ──────────────────────────────────────────────

interface DeepLink {
  fromPlace: PlaceResult | null;
  toPlace: PlaceResult | null;
  mode: ModeId;
}

function coordPlace(raw: string, label: string): PlaceResult | null {
  const [latStr, lonStr] = raw.split(',');
  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    place_id: `${label}:${lat},${lon}`,
    title: label,
    subtitle: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    address_lines: [label],
    lat,
    lon,
    kind: 'deep-link',
  };
}

function parseDeepLink(): DeepLink | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const fromRaw = params.get('from');
  const toRaw = params.get('to');
  if (!fromRaw && !toRaw) return null;
  const modeRaw = params.get('mode');
  const mode: ModeId =
    modeRaw === 'pedestrian' || modeRaw === 'bicycle' ? modeRaw : 'auto';
  return {
    fromPlace: fromRaw ? coordPlace(fromRaw, 'Start') : null,
    toPlace: toRaw ? coordPlace(toRaw, 'Destination') : null,
    mode,
  };
}

export default MapsPage;
