/**
 * MapsPage — Apple Maps-style two-pane layout (Chunk 4).
 *
 * Left column (320px): `LeftRail` with brand + Search/Guides/Directions
 * nav + Recents + footer link to Settings → Maps.
 *
 * Right column (1fr): the map surface. MapLibre renders the vector
 * basemap via the `pmtiles://` protocol; the tile-source resolver picks
 * between a local installed region and the online Protomaps demo.
 * Active panels (SearchPanel / PlaceDetailsCard / GuidesPanel /
 * DirectionsPanelPlaceholder) are pinned as a 360px sheet at the
 * map's top-left so the rail nav stays visible alongside.
 *
 * Place selection flow: SearchPanel → onSelect(place) → MapsPage drops
 * a pin, flies the map, pushes to `recents`, and shows PlaceDetailsCard.
 * Clicking the blue Directions button flips activePanel to
 * `directions`, which renders the placeholder until Chunk 7.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { MapPin } from 'lucide-react';
import { buildDarkStyle, type LayerMode } from './maps/style-dark';
import {
  fetchInstalledRegions,
  resolveTileSource,
  type InstalledRegion,
  type ResolveResult,
} from './maps/tile-source';
import LayerModeChip from './maps/LayerModeChip';
import OutOfCoverageBanner from './maps/OutOfCoverageBanner';
import LeftRail from './maps/LeftRail';
import SearchPanel from './maps/panels/SearchPanel';
import PlaceDetailsCard from './maps/panels/PlaceDetailsCard';
import GuidesPanel from './maps/panels/GuidesPanel';
import DirectionsPanelPlaceholder from './maps/panels/DirectionsPanelPlaceholder';
import { loadRecents, pushRecent } from './maps/recents';
import type { ActivePanel, PlaceResult, Recent } from './maps/types';
import Sidebar from '../components/sidebar/Sidebar';
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

  const [activePanel, setActivePanel] = useState<ActivePanel>('search');
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
  const [recents, setRecents] = useState<Recent[]>(() => loadRecents());
  const [railCollapsed, setRailCollapsed] = useState(false);

  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState('');

  // Layer mode + coverage resolution — carried over from Chunk 3.
  const [mode, setMode] = useState<LayerMode>('map');
  const [regions, setRegions] = useState<InstalledRegion[]>([]);
  const [resolution, setResolution] = useState<ResolveResult | null>(null);
  const [viewportCenter, setViewportCenter] = useState<{ lng: number; lat: number } | null>(null);
  const regionsRef = useRef<InstalledRegion[]>([]);

  const satelliteAvailable = useMemo(
    () => regions.some((r) => r.has_satellite),
    [regions],
  );

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

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
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
        .then((next) => setResolution(next));
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
      const initial = await resolveTileSource(undefined, fetched);
      if (cancelled) return;
      setResolution(initial);
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

    const streetUrl = resolution.streetUrl;
    const satUrlTemplate =
      resolution.kind === 'local' ? resolution.satUrlTemplate : null;
    map.setStyle(
      buildDarkStyle(streetUrl, { mode, satelliteUrlTemplate: satUrlTemplate }),
    );
  }, [mode, resolution]);

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
    markerRef.current?.remove();
    markerRef.current = null;
    hoverMarkerRef.current?.remove();
    hoverMarkerRef.current = null;
  }, []);

  // Choose which panel body to render inside the floating sheet.
  const panelBody = useMemo(() => {
    if (activePanel === 'directions') {
      return (
        <DirectionsPanelPlaceholder
          toPlace={selectedPlace}
          onClose={closePanel}
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
    viewportCenter,
    handleSelect,
    handleHover,
    handleDirections,
    closePanel,
  ]);

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />
      <main
        className="flex-1 grid min-w-0 h-screen"
        style={{
          gridTemplateColumns: railCollapsed ? '72px 1fr' : '320px 1fr',
        }}
      >
        <LeftRail
          active={activePanel}
          onSelectPanel={handleSelectPanel}
          recents={recents}
          onSelectRecent={handleSelectRecent}
          collapsed={railCollapsed}
          onToggleCollapsed={() => setRailCollapsed((v) => !v)}
        />

        <div className="relative min-w-0 h-full">
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

          {/* Floating panel sheet — lives inside the map surface, pinned
              to the top-left corner. Mirrors Apple Maps' inline sheet. */}
          {panelBody && (
            <div className="absolute left-4 top-4 z-10 w-[360px] max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-border/30 bg-card/95 backdrop-blur shadow-m4 flex flex-col">
              {panelBody}
            </div>
          )}

          {/* Top-right layer chip */}
          <div className="absolute right-4 top-32 z-10 pointer-events-auto">
            <LayerModeChip
              mode={mode}
              onChange={setMode}
              satelliteAvailable={satelliteAvailable}
            />
          </div>

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

          {/* Attribution pill */}
          <div className="absolute bottom-4 left-4 z-10 pointer-events-none">
            <div className="rounded-full bg-card/80 backdrop-blur px-3 py-1 text-[10px] text-muted-foreground flex items-center gap-1.5">
              <MapPin size={10} />
              OpenStreetMap · Nominatim
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default MapsPage;
