/**
 * MapsPage — Google-Maps-style search + MapLibre GL viewer.
 *
 * Layout mimics Google Maps: a floating search column on the left
 * (type-ahead results, click a row to fly the map). The map fills the
 * rest of the viewport.
 *
 * Search uses Nominatim with a country filter (US default, toggle to
 * "Worldwide") so noisy global hits don't bury the one the user wants.
 * Non-locatable results are filtered out in JS — Nominatim occasionally
 * returns entries without lat/lon (e.g. relations with empty coords).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Dark-theme override for MapLibre's default popup + controls — without
// this the popup renders as white-on-white over the (dark-mode) map
// tiles, and the zoom/navigation chrome has no contrast against the
// background. Injected once via a <style> tag in a module-level effect
// so we don't duplicate stylesheets across remounts.
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
import { MapPin, Search, Loader2, Globe, X } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import { useDocumentTitle } from '../lib/useDocumentTitle';

// ── Types ──────────────────────────────────────────────────────

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type: string;
  class: string;
  importance: number;
}

// Popular country scope options. Keep short — a full dropdown of 200
// ISO codes is overwhelming. Users who need a different country can
// pick "Worldwide" and include the country name in the query.
const COUNTRY_OPTIONS: Array<{ code: string; label: string }> = [
  { code: 'us', label: 'United States' },
  { code: 'ca', label: 'Canada' },
  { code: 'gb', label: 'United Kingdom' },
  { code: 'au', label: 'Australia' },
  { code: '',   label: 'Worldwide' },
];

// ── Map style — swap for Protomaps PMTiles to go fully offline later ──

const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const mapStyle: maplibregl.StyleSpecification = {
  version: 8,
  // Use a PNG:// glyphs URL placeholder — MapLibre needs glyphs defined
  // for text layers, but since we only render raster tiles we can omit.
  sources: {
    osm: {
      type: 'raster',
      tiles: [OSM_TILE_URL],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxzoom: 19,
    },
  },
  layers: [
    // Solid background layer so the canvas paints SOMETHING even when
    // tile requests fail (ad-blocker, rate-limited, offline). Without
    // this a blocked tile server makes the whole map area look missing.
    { id: 'bg', type: 'background', paint: { 'background-color': '#1a1d22' } },
    { id: 'osm', type: 'raster', source: 'osm' },
  ],
};

// ── Component ──────────────────────────────────────────────────

const MapsPage: React.FC = () => {
  useDocumentTitle('Maps');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [query, setQuery] = useState('');
  const [countryCode, setCountryCode] = useState('us');
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState('');

  // ── Initialize the map ───────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Synchronous init — the useEffect fires after the DOM is attached,
    // so the container has dimensions. Earlier versions tried RAF to
    // "wait for layout" but that introduced a race in React 19 strict
    // mode where the cleanup cancelled the init. Just initialize now.
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container,
        style: mapStyle,
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
      // Extra resize() on load — belt and braces for the 0×0 canvas bug
      // where the container briefly lacks dimensions during init.
      map.resize();
    });
    map.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.warn('MapLibre error', e);
    });

    // WebGL contexts can be lost when the GPU resets, the tab
    // backgrounds too aggressively, or too many contexts are open. Tell
    // the canvas to re-acquire context automatically rather than
    // silently dying.
    const canvas = map.getCanvas();
    const onCtxLost = (e: Event) => {
      e.preventDefault();  // allow context restore
      setMapError('Map context lost — reloading tiles…');
    };
    const onCtxRestored = () => {
      setMapError('');
      map.triggerRepaint();
    };
    canvas.addEventListener('webglcontextlost', onCtxLost);
    canvas.addEventListener('webglcontextrestored', onCtxRestored);

    mapRef.current = map;

    // ResizeObserver — force a canvas resize whenever the container
    // dimensions change (sidebar collapse, window resize, etc).
    const ro = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // ── Geocoding ────────────────────────────────────────────────
  const runSearch = useCallback(async (text: string, country: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setResults([]);
      setSearchError('');
      return;
    }
    // Cancel any in-flight request so fast typing doesn't flood Nominatim.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSearching(true);
    setSearchError('');
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', trimmed);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '10');
      url.searchParams.set('addressdetails', '0');
      if (country) url.searchParams.set('countrycodes', country);

      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          'Accept-Language': navigator.language || 'en',
          // Nominatim usage policy asks for a distinct UA; browser
          // UA is fine for a personal assistant.
        },
      });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      const raw: NominatimResult[] = await res.json();

      // Drop entries without parseable coordinates — those were the
      // "not map results" the user was seeing (relation rows, etc).
      const clean = raw.filter(r => {
        const lat = parseFloat(r.lat);
        const lon = parseFloat(r.lon);
        return Number.isFinite(lat) && Number.isFinite(lon);
      });
      setResults(clean);
      if (clean.length === 0) setSearchError(`No locations for "${trimmed}"`);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return;
      setResults([]);
      setSearchError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }, []);

  // Debounced type-ahead — fires 350ms after the last keystroke.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setSearchError('');
      return;
    }
    debounceRef.current = setTimeout(() => {
      runSearch(query, countryCode);
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, countryCode, runSearch]);

  const flyTo = useCallback((result: NominatimResult) => {
    const map = mapRef.current;
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      // eslint-disable-next-line no-console
      console.warn('[Maps] result has no valid lat/lon', result);
      return;
    }
    if (!map) {
      // eslint-disable-next-line no-console
      console.warn('[Maps] flyTo called but map not initialized yet');
      setSelectedId(result.place_id);
      return;
    }

    markerRef.current?.remove();
    markerRef.current = new maplibregl.Marker({ color: '#f97316' })
      .setLngLat([lon, lat])
      .setPopup(new maplibregl.Popup({ offset: 25 }).setText(result.display_name))
      .addTo(map);
    markerRef.current.togglePopup();

    // Zoom heuristic: countries/states zoom out, addresses zoom in.
    const zoom = result.type === 'country' ? 4
      : result.type === 'state' || result.type === 'administrative' ? 7
      : result.type === 'city' || result.type === 'town' ? 11
      : result.type === 'postcode' ? 13
      : 16;

    map.flyTo({ center: [lon, lat], zoom, speed: 1.5, curve: 1.6 });
    setSelectedId(result.place_id);
  }, []);

  const splitName = useMemo(
    () => (full: string) => {
      const [head, ...rest] = full.split(', ');
      return { head, tail: rest.join(', ') };
    },
    [],
  );

  const clearSearch = () => {
    setQuery('');
    setResults([]);
    setSearchError('');
    setSelectedId(null);
  };

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />
      <main className="flex-1 relative min-w-0 h-screen">
        {/* Map canvas — explicit 100% dims so MapLibre always sees a
            non-zero container at init time. Black bg prevents the app
            shell colour bleeding through during tile fetch. */}
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

        {/* Floating search panel — Google-Maps-style on top-left */}
        <div className="absolute left-4 top-4 z-10 w-[min(420px,calc(100vw-2rem))] flex flex-col gap-2 pointer-events-none">
          <div className="pointer-events-auto rounded-2xl border border-border/30 bg-card/95 backdrop-blur shadow-m4 overflow-hidden">
            {/* Top row — search bar + country pill */}
            <div className="flex items-center gap-0">
              <div className="relative flex-1 min-w-0">
                {searching
                  ? <Loader2 size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin" />
                  : <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />}
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search address, city, ZIP, country…"
                  className="w-full bg-transparent py-3.5 pl-12 pr-10 text-sm placeholder:text-muted-foreground focus:outline-none"
                />
                {query && (
                  <button
                    onClick={clearSearch}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                    aria-label="Clear"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              <div className="h-8 w-px bg-border/40" />
              <div className="relative pr-2">
                <Globe size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <select
                  value={countryCode}
                  onChange={e => setCountryCode(e.target.value)}
                  className="appearance-none bg-transparent pl-8 pr-2 py-3 text-xs text-muted-foreground hover:text-foreground focus:outline-none cursor-pointer"
                  aria-label="Country scope"
                >
                  {COUNTRY_OPTIONS.map(c => (
                    <option key={c.code} value={c.code}>{c.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Results / error */}
            {(results.length > 0 || searchError) && (
              <div className="border-t border-border/30">
                {searchError && (
                  <div className="px-4 py-3 text-xs text-muted-foreground">{searchError}</div>
                )}
                {results.length > 0 && (
                  <ul className="max-h-[60vh] overflow-y-auto divide-y divide-border/20">
                    {results.map(r => {
                      const { head, tail } = splitName(r.display_name);
                      const isActive = r.place_id === selectedId;
                      return (
                        <li key={r.place_id}>
                          <button
                            type="button"
                            onClick={() => flyTo(r)}
                            className={`w-full text-left px-4 py-3 transition-colors ${
                              isActive
                                ? 'bg-primary/10'
                                : 'hover:bg-card'
                            }`}
                          >
                            <div className="text-sm font-semibold tracking-tight truncate">
                              {head}
                            </div>
                            {tail && (
                              <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                                {tail}
                              </div>
                            )}
                            <div className="text-[10px] text-muted-foreground/60 mt-1 uppercase tracking-wider">
                              {r.class}
                              {r.type && r.type !== r.class ? ` · ${r.type}` : ''}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Map status — loading or error */}
          {mapError && (
            <div className="pointer-events-none rounded-full bg-destructive/90 backdrop-blur px-3 py-1.5 text-[10px] text-destructive-foreground w-fit">
              {mapError}
            </div>
          )}
          {!mapReady && !mapError && (
            <div className="pointer-events-none rounded-full bg-card/90 backdrop-blur px-3 py-1.5 text-[10px] text-muted-foreground w-fit">
              Loading map…
            </div>
          )}
        </div>

        {/* Bottom-right attribution pill */}
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

export default MapsPage;
