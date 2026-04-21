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
import { type LayerMode } from './maps/style-dark';
import { buildStyle } from './maps/style-factory';
import LayerModeChip from './maps/LayerModeChip';
import { installMissingImageLoader } from './maps/missing-image-loader';
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
import PoiHoverPreview from './maps/panels/PoiHoverPreview';
import GuidesPanel from './maps/panels/GuidesPanel';
import DirectionsPanel from './maps/panels/DirectionsPanel';
import { formatPoiCategoryLabel } from './maps/panels/poi-icons';
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
import { fitMapToCoords } from './maps/fit-coords';
import { loadRecents, pushRecent, removeRecent } from './maps/recents';
import type { ActivePanel, PlaceResult, Recent } from './maps/types';
import { useMapTheme } from './maps/use-map-theme';
import { useDocumentTitle } from '../lib/useDocumentTitle';

// Global z0–z7 Natural Earth basemap served by bootstrap. Paired with
// the per-region tile URL in every `buildDarkStyle` call so country /
// state polygons + ocean fill render worldwide at low zoom, closing the
// "blank outside installed region" gap.
const OVERVIEW_PMTILES_URL =
  'pmtiles:///api/v1/maps/tiles/_overview/streets.pmtiles';

// Static country + state label GeoJSON built from Natural Earth. Rendered
// as a maplibre ``geojson`` source because planetiler's OpenMapTiles
// profile sources ``place=*`` from OSM (and the overview pmtiles uses
// Monaco as its OSM input — so only Monaco labels flow through that
// path). Loading this file gives us country/state names globally.
const WORLD_LABELS_URL = '/api/v1/maps/tiles/_overview/labels.geojson';
const REVERSE_GEOCODE_URL = '/api/v1/maps/geocode/reverse';
const CLICKABLE_LAYER_IDS = ['poi_icon', 'buildings-3d', 'buildings-2d'] as const;

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

// Dark-theme override for MapLibre controls.
const MAPLIBRE_DARK_CSS = `
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

type MapFeatureProperties = Record<string, unknown> & {
  name?: string;
  'name:en'?: string;
  class?: string;
  subclass?: string;
  street?: string;
  housenumber?: string;
  ['addr:street']?: string;
  ['addr:housenumber']?: string;
  ['addr:city']?: string;
  ['addr:state']?: string;
  ['addr:postcode']?: string;
  city?: string;
  state?: string;
  postcode?: string;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function subtitleFromProps(props: MapFeatureProperties): string {
  const [address, locality] = addressLinesFromProps(props);
  return (
    address
    || locality
    || formatPoiCategoryLabel(asString(props.subclass))
    || formatPoiCategoryLabel(asString(props.class))
  );
}

function addressLinesFromProps(props: MapFeatureProperties): string[] {
  const number = asString(props.housenumber) || asString(props['addr:housenumber']);
  const street = asString(props.street) || asString(props['addr:street']);
  const address = [number, street].filter(Boolean).join(' ').trim();
  const city = asString(props.city) || asString(props['addr:city']);
  const state = asString(props.state) || asString(props['addr:state']);
  const postcode = asString(props.postcode) || asString(props['addr:postcode']);
  const locality = [city, [state, postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [address, locality].filter(Boolean);
}

function titleFromProps(props: MapFeatureProperties): string {
  return asString(props['name:en']) || asString(props.name);
}

function categoryFromProps(props: MapFeatureProperties): string | undefined {
  return asString(props.subclass) || asString(props.class) || undefined;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function isMachineRegionCode(value: string): boolean {
  return /^[a-z]{2}(?:-[a-z]{2,})+$/i.test(value.trim());
}

function uniqueUsefulLines(name: string, lines: string[]): string[] {
  const seen = new Set<string>([normalizeLabel(name)]);
  const cleaned: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || isMachineRegionCode(line)) continue;
    const normalized = normalizeLabel(line);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    cleaned.push(line);
  }
  return cleaned;
}

function buildHoverAddressLines(name: string, addressLines: string[]): string[] {
  return uniqueUsefulLines(name, addressLines).slice(0, 2);
}

function hoverCategoryLabel(category: string | undefined, subtitle?: string): string {
  const formattedCategory = formatPoiCategoryLabel(category);
  if (formattedCategory) {
    return formattedCategory;
  }
  const fallback = uniqueUsefulLines('', [subtitle ?? ''])[0];
  return fallback ?? '';
}

async function reverseGeocode(
  lat: number,
  lon: number,
  radiusKm?: number,
): Promise<PlaceResult | null> {
  const url = new URL(REVERSE_GEOCODE_URL, window.location.origin);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  if (typeof radiusKm === 'number' && Number.isFinite(radiusKm)) {
    url.searchParams.set('radius_km', String(radiusKm));
  }
  const res = await fetch(url.toString());
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Reverse geocoder ${res.status}`);
  }
  const body = await res.json() as {
    place_id: string;
    title: string;
    subtitle: string;
    lat: number;
    lon: number;
    source: string;
  };
  const lines = [body.title, body.subtitle].filter(Boolean);
  return {
    place_id: body.place_id,
    title: body.title,
    subtitle: body.subtitle,
    address_lines: lines.length > 0 ? lines : [body.place_id],
    lat: body.lat,
    lon: body.lon,
    kind: 'address',
  };
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

  const [hoverTarget, setHoverTarget] = useState<{
    name: string;
    categoryLabel: string;
    addressLines: string[];
    category?: string;
    lat: number;
    lon: number;
    screenX: number;
    screenY: number;
  } | null>(null);
  const hoverReverseCacheRef = useRef<Map<string, PlaceResult | null>>(new Map());
  const hoverRequestIdRef = useRef(0);
  // Grace timer so cursor can cross the gap from POI icon into the
  // hover card without the card collapsing under it.
  const hoverDismissTimer = useRef<number | null>(null);
  const cancelHoverDismiss = useCallback(() => {
    if (hoverDismissTimer.current !== null) {
      window.clearTimeout(hoverDismissTimer.current);
      hoverDismissTimer.current = null;
    }
  }, []);
  const scheduleHoverDismiss = useCallback(() => {
    cancelHoverDismiss();
    hoverDismissTimer.current = window.setTimeout(() => {
      hoverDismissTimer.current = null;
      setHoverTarget(null);
    }, 180);
  }, [cancelHoverDismiss]);

  // Layer mode — flat ``map`` or ``3d`` (fill-extrusion buildings).
  // Flipping to 3D auto-pitches the camera; flipping back resets pitch
  // iff the user hasn't tilted it themselves in the meantime.
  const [mode, setMode] = useState<LayerMode>('map');
  const { theme } = useMapTheme();

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
        // Sprite is preloaded on the initial empty style so MapLibre
        // caches the image atlas before the first real setStyle swap.
        // Without this, the diff'd setStyle that follows sometimes
        // skips a fresh sprite fetch and every icon-image reference
        // logs "could not be loaded" in the console.
        style: {
          version: 8,
          sprite: '/sprites/maps-sprite',
          glyphs: '/api/v1/maps/glyphs/{fontstack}/{range}.pbf',
          sources: {},
          layers: [],
        },
        center: [-98.5, 39.8],
        zoom: 3,
        attributionControl: false,
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

    // Defensive sprite fallback: if MapLibre asks for an icon the
    // current sprite atlas doesn't know about, fetch the matching
    // SVG and register it by hand. Keep the guard scoped to in-flight
    // loads only so style swaps can re-register the same ids.
    const removeMissingImageLoader = installMissingImageLoader(map);

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
      // Auto-fit to the first installed region's bbox unless the user
      // arrived via a deep link. The map starts centered on the US at
      // zoom 3 — without this jump the initial viewport sits outside
      // every installed bbox, so tile panning near the coverage edge
      // churns the source and nothing renders where the user is
      // actually looking.
      if (fetched.length > 0 && mapRef.current) {
        if (deepLink?.toPlace) {
          // Deep link supplies the target point: fly straight there so
          // the directions panel opens over a real map, not a blank
          // out-of-coverage canvas.
          mapRef.current.jumpTo({
            center: [deepLink.toPlace.lon, deepLink.toPlace.lat],
            zoom: 14,
          });
        } else if (!deepLink) {
          const [minLon, minLat, maxLon, maxLat] = fetched[0].bbox;
          mapRef.current.fitBounds(
            [[minLon, minLat], [maxLon, maxLat]],
            { padding: 40, duration: 0, maxZoom: 12 },
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      removeCtxListeners?.();
      removeMissingImageLoader();
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

    const style = buildStyle(
      theme,
      resolution.streetUrl,
      OVERVIEW_PMTILES_URL,
      WORLD_LABELS_URL,
      { mode },
    );
    style.sprite = '/sprites/maps-sprite';
    // diff=false forces a full style rebuild so the sprite atlas is
    // (re)fetched and every icon-image reference resolves on first
    // render. Diffing was silently skipping the sprite refresh,
    // leaving POI badges and highway shields unrendered.
    map.setStyle(style, { diff: false });
  }, [mode, resolution, theme]);

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
      .addTo(map);

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

  const hydrateHoverAddress = useCallback(
    async (name: string, lat: number, lon: number, requestId: number) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      // Widen the search radius: POI coordinates often sit hundreds of
      // metres from their parcel centroid, so the default 50 m cap
      // returns the POI itself (no street address) instead of a
      // neighbouring OpenAddresses row.
      const cacheKey = `hover:${lat.toFixed(5)},${lon.toFixed(5)}`;
      let place = hoverReverseCacheRef.current.get(cacheKey);
      if (place === undefined) {
        try {
          place = await reverseGeocode(lat, lon, 0.2);
        } catch {
          place = null;
        }
        hoverReverseCacheRef.current.set(cacheKey, place);
      }
      if (!place?.address_lines.length) return;
      setHoverTarget((current) => {
        if (!current) return current;
        if (hoverRequestIdRef.current !== requestId) return current;
        if (current.name !== name || current.lat !== lat || current.lon !== lon) {
          return current;
        }
        const addressLines = buildHoverAddressLines(name, place.address_lines);
        if (addressLines.length === 0) return current;
        if (JSON.stringify(current.addressLines) === JSON.stringify(addressLines)) {
          return current;
        }
        return {
          ...current,
          addressLines,
        };
      });
    },
    [],
  );

  // Building hover: the building layer has no `name` (residential
  // footprints in OpenMapTiles carry only `render_height`), so we
  // synthesize the hover target from a tight reverse-geocode.
  const hydrateBuildingHover = useCallback(
    async (
      lat: number,
      lon: number,
      screenX: number,
      screenY: number,
      requestId: number,
    ) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const cacheKey = `building:${lat.toFixed(5)},${lon.toFixed(5)}`;
      let place = hoverReverseCacheRef.current.get(cacheKey);
      if (place === undefined) {
        try {
          place = await reverseGeocode(lat, lon, 0.05);
        } catch {
          place = null;
        }
        hoverReverseCacheRef.current.set(cacheKey, place);
      }
      if (!place) return;
      setHoverTarget((current) => {
        if (hoverRequestIdRef.current !== requestId) return current;
        const addressLines = buildHoverAddressLines(place.title, place.address_lines);
        return {
          name: place.title,
          categoryLabel: place.subtitle || '',
          addressLines,
          category: place.kind,
          lat,
          lon,
          screenX,
          screenY,
        };
      });
    },
    [],
  );

  const handleSelectRecent = useCallback((place: PlaceResult) => {
    pinAndFly(place);
    setSelectedPlace(place);
    setRecents(pushRecent(place));
    setActivePanel(null);
  }, [pinAndFly]);

  const handleRemoveRecent = useCallback((placeId: string) => {
    setRecents(removeRecent(placeId));
  }, []);

  const handleDirections = useCallback((_place: PlaceResult) => {
    setActivePanel('directions');
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const handleMapClick = async (event: maplibregl.MapMouseEvent) => {
      const layers = CLICKABLE_LAYER_IDS.filter((id) => map.getLayer(id));
      if (layers.length === 0) return;
      const hits = map.queryRenderedFeatures(event.point, { layers });
      const top = hits[0];
      if (!top) return;
      const props = (top.properties ?? {}) as MapFeatureProperties;
      const title = titleFromProps(props);
      if (title) {
        const addressLines = addressLinesFromProps(props);
        const place: PlaceResult = {
          place_id: String(top.id ?? `${event.lngLat.lat},${event.lngLat.lng}`),
          title,
          subtitle: subtitleFromProps(props),
          address_lines: addressLines.length > 0 ? addressLines : [title],
          lat: event.lngLat.lat,
          lon: event.lngLat.lng,
          kind: categoryFromProps(props),
        };
        handleSelect(place);
        return;
      }
      try {
        const place = await reverseGeocode(event.lngLat.lat, event.lngLat.lng);
        if (place) {
          handleSelect(place);
        }
      } catch (error) {
        setMapError(
          error instanceof Error ? error.message : 'Reverse geocode failed',
        );
      }
    };

    map.on('click', handleMapClick);
    return () => {
      map.off('click', handleMapClick);
    };
  }, [handleSelect, mapReady]);

  // ── Hover preview on POI icons ────────────────────────────────
  // rAF-throttled mousemove so hover-dragging across many pins
  // doesn't re-render the preview every pointer event.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let rafId: number | null = null;
    let pending: {
      feature: unknown;
      x: number;
      y: number;
      lng: number;
      lat: number;
    } | null = null;

    const flush = () => {
      rafId = null;
      if (!pending) return;
      const { feature, x, y, lng, lat } = pending;
      pending = null;
      const props = ((feature as { properties?: MapFeatureProperties }).properties
        ?? {}) as MapFeatureProperties;
      const name = titleFromProps(props);
      if (!name) {
        setHoverTarget(null);
        return;
      }
      const category = categoryFromProps(props);
      const nextTarget = {
        name,
        categoryLabel: hoverCategoryLabel(category, subtitleFromProps(props)),
        addressLines: buildHoverAddressLines(name, addressLinesFromProps(props)),
        category,
        lat,
        lon: lng,
        screenX: x,
        screenY: y,
      };
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      setHoverTarget(nextTarget);
      if (nextTarget.addressLines.length === 0) {
        void hydrateHoverAddress(name, lat, lng, requestId);
      }
    };

    const handleMove = (event: unknown) => {
      const evt = event as {
        features?: { properties?: MapFeatureProperties }[];
        originalEvent?: { clientX: number; clientY: number };
        point?: { x: number; y: number };
        lngLat?: { lng: number; lat: number };
      };
      const feat = evt.features?.[0];
      if (!feat) return;
      const x = evt.originalEvent?.clientX ?? evt.point?.x ?? 0;
      const y = evt.originalEvent?.clientY ?? evt.point?.y ?? 0;
      const lng = evt.lngLat?.lng ?? 0;
      const lat = evt.lngLat?.lat ?? 0;
      cancelHoverDismiss();
      map.getCanvas().style.cursor = 'pointer';
      pending = { feature: feat, x, y, lng, lat };
      if (rafId === null) {
        rafId = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(flush)
          : (setTimeout(flush, 33) as unknown as number);
      }
    };

    const handleLeave = () => {
      hoverRequestIdRef.current += 1;
      pending = null;
      if (rafId !== null) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafId);
        } else {
          clearTimeout(rafId as unknown as ReturnType<typeof setTimeout>);
        }
        rafId = null;
      }
      map.getCanvas().style.cursor = '';
      // Delay clear so cursor can move into the preview card.
      scheduleHoverDismiss();
    };

    // Buildings never expose a name in OpenMapTiles' `building`
    // source-layer, so we can't reuse `flush` — it early-returns on
    // missing name. We rAF-throttle building moves independently and
    // hand them to `hydrateBuildingHover` which synthesises the card
    // from a tight reverse-geocode.
    let bRafId: number | null = null;
    let bPending: { x: number; y: number; lng: number; lat: number } | null = null;
    const bFlush = () => {
      bRafId = null;
      if (!bPending) return;
      const { x, y, lng, lat } = bPending;
      bPending = null;
      const requestId = hoverRequestIdRef.current + 1;
      hoverRequestIdRef.current = requestId;
      void hydrateBuildingHover(lat, lng, x, y, requestId);
    };
    const handleBuildingMove = (event: unknown) => {
      const evt = event as {
        features?: { properties?: MapFeatureProperties }[];
        originalEvent?: { clientX: number; clientY: number };
        point?: { x: number; y: number };
        lngLat?: { lng: number; lat: number };
      };
      const feat = evt.features?.[0];
      if (!feat) return;
      const props = (feat.properties ?? {}) as MapFeatureProperties;
      // If the building carries a name (shops, labelled landmarks), the
      // POI-icon handler already covers the hover — don't double-fire.
      if (titleFromProps(props)) return;
      const x = evt.originalEvent?.clientX ?? evt.point?.x ?? 0;
      const y = evt.originalEvent?.clientY ?? evt.point?.y ?? 0;
      const lng = evt.lngLat?.lng ?? 0;
      const lat = evt.lngLat?.lat ?? 0;
      cancelHoverDismiss();
      map.getCanvas().style.cursor = 'pointer';
      bPending = { x, y, lng, lat };
      if (bRafId === null) {
        bRafId = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(bFlush)
          : (setTimeout(bFlush, 33) as unknown as number);
      }
    };
    const handleBuildingLeave = () => {
      bPending = null;
      if (bRafId !== null) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(bRafId);
        } else {
          clearTimeout(bRafId as unknown as ReturnType<typeof setTimeout>);
        }
        bRafId = null;
      }
      map.getCanvas().style.cursor = '';
      scheduleHoverDismiss();
    };

    map.on('mousemove', 'poi_icon', handleMove);
    map.on('mouseleave', 'poi_icon', handleLeave);
    map.on('mousemove', 'buildings-3d', handleBuildingMove);
    map.on('mouseleave', 'buildings-3d', handleBuildingLeave);
    map.on('mousemove', 'buildings-2d', handleBuildingMove);
    map.on('mouseleave', 'buildings-2d', handleBuildingLeave);
    return () => {
      map.off('mousemove', 'poi_icon', handleMove);
      map.off('mouseleave', 'poi_icon', handleLeave);
      map.off('mousemove', 'buildings-3d', handleBuildingMove);
      map.off('mouseleave', 'buildings-3d', handleBuildingLeave);
      map.off('mousemove', 'buildings-2d', handleBuildingMove);
      map.off('mouseleave', 'buildings-2d', handleBuildingLeave);
      if (rafId !== null) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafId);
        } else {
          clearTimeout(rafId as unknown as ReturnType<typeof setTimeout>);
        }
      }
      if (bRafId !== null) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(bRafId);
        } else {
          clearTimeout(bRafId as unknown as ReturnType<typeof setTimeout>);
        }
      }
      cancelHoverDismiss();
    };
  }, [
    cancelHoverDismiss,
    hydrateBuildingHover,
    hydrateHoverAddress,
    mapReady,
    scheduleHoverDismiss,
  ]);

  const handleRoutesChanged = useCallback(
    (alts: RouteAlt[], selectedIdx: number) => {
      setRouteAlts(alts);
      setRouteSelectedIdx(selectedIdx);
    },
    [],
  );

  const handleFitToCoords = useCallback((coords: [number, number][]) => {
    const map = mapRef.current;
    if (!map) return;
    fitMapToCoords(map, coords);
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
      // First paint after alternates arrive → fit to the union bounds,
      // but guard against degenerate bounds (e.g. geolocation returned
      // [0,0] or a bogus far-away start). If the span is wider than a
      // reasonable trip (10° ≈ 700 mi) we fall back to centering on the
      // to-place instead of fitting a world-wide rectangle.
      if (routeSelectedIdx === 0) {
        const bounds = boundsForAlts(routeAlts);
        if (bounds) {
          const [[minLng, minLat], [maxLng, maxLat]] = bounds;
          const spanLng = Math.abs(maxLng - minLng);
          const spanLat = Math.abs(maxLat - minLat);
          if (spanLng > 10 || spanLat > 10) {
            if (selectedPlace) {
              map.flyTo({
                center: [selectedPlace.lon, selectedPlace.lat],
                zoom: 13,
                duration: 600,
              });
            }
          } else {
            map.fitBounds(bounds, { padding: 80, duration: 600, maxZoom: 15 });
          }
        }
      }
    } catch {
      // Safe no-op if the style swap is mid-flight.
    }
  }, [mapReady, routeAlts, routeSelectedIdx, selectedPlace]);

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
          category={selectedPlace.kind}
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
        onRemoveRecent={handleRemoveRecent}
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

          {/* Hover-preview card — ephemeral, cursor-anchored. Does NOT
              swap the active panel or selection; the click path still
              owns the full PlaceDetailsCard. */}
          {hoverTarget && (
            <PoiHoverPreview
              name={hoverTarget.name}
              categoryLabel={hoverTarget.categoryLabel}
              addressLines={hoverTarget.addressLines}
              category={hoverTarget.category}
              screenX={hoverTarget.screenX}
              screenY={hoverTarget.screenY}
              onMouseEnter={cancelHoverDismiss}
              onMouseLeave={scheduleHoverDismiss}
              onDirections={() => {
                const place: PlaceResult = {
                  place_id: `poi:${hoverTarget.lat.toFixed(5)},${hoverTarget.lon.toFixed(5)}`,
                  title: hoverTarget.name,
                  subtitle: hoverTarget.categoryLabel,
                  address_lines: hoverTarget.addressLines,
                  lat: hoverTarget.lat,
                  lon: hoverTarget.lon,
                  kind: hoverTarget.category,
                };
                handleSelect(place);
                setHoverTarget(null);
                setActivePanel('directions');
              }}
              onShare={() => {
                const text = [
                  hoverTarget.name,
                  hoverTarget.categoryLabel,
                  ...hoverTarget.addressLines,
                  `${hoverTarget.lat.toFixed(5)}, ${hoverTarget.lon.toFixed(5)}`,
                ].filter(Boolean).join(' — ');
                void navigator.clipboard?.writeText(text).catch(() => {});
                setHoverTarget(null);
              }}
            />
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

        {/* Layer-mode chip — bottom-right, clear of the MapLibre
            navigation controls stacked in the top-right corner. */}
        <div className="absolute bottom-4 right-3 z-10">
          <LayerModeChip mode={mode} onChange={setMode} />
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
