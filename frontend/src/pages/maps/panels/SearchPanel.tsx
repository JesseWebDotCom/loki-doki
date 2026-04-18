/**
 * Search panel — the "Search" left-rail item's main pane.
 *
 * Chunk 5 moved the fetch off Nominatim and onto the offline FTS5
 * backend at `/api/v1/maps/geocode`. The backend unions results across
 * every installed region whose bbox covers the viewport, and only
 * falls back to Nominatim when no region covers the current area.
 *
 * Results reach the parent via `onSelect(place)` — `MapsPage` drops the
 * pin, flies the map, pushes to recents, and switches to the
 * place-details view. This component only owns the input + dropdown.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MapPin, Search as SearchIcon, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { PlaceResult } from '../types';

const GEOCODE_URL = '/api/v1/maps/geocode';
const MAX_RESULTS = 10;
const DEBOUNCE_MS = 300;

export interface ViewportCenter {
  lng: number;
  lat: number;
}

export interface SearchResponse {
  results: PlaceResult[];
  fallback_used: boolean;
  offline: boolean;
}

interface GeocodeRaw {
  place_id: string;
  title: string;
  subtitle: string;
  lat: number;
  lon: number;
  bbox: number[] | null;
  source: 'fts' | 'nominatim';
}

/**
 * Single callsite for place search. Hits the offline FTS backend first
 * and surfaces `fallback_used` / `offline` to the caller so the panel
 * can render the right helper chip.
 */
export async function searchPlaces(
  query: string,
  viewportCenter: ViewportCenter | null,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) return { results: [], fallback_used: false, offline: false };

  const url = new URL(GEOCODE_URL, window.location.origin);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('limit', String(MAX_RESULTS));
  if (viewportCenter) {
    url.searchParams.set('lat', String(viewportCenter.lat));
    url.searchParams.set('lon', String(viewportCenter.lng));
  }

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`Geocoder ${res.status}`);
  const body = (await res.json()) as {
    results: GeocodeRaw[];
    fallback_used?: boolean;
    offline?: boolean;
  };
  return {
    results: body.results.map(toPlaceResult).filter(isLocatable),
    fallback_used: Boolean(body.fallback_used),
    offline: Boolean(body.offline),
  };
}

function toPlaceResult(r: GeocodeRaw): PlaceResult {
  const lines: string[] = [];
  if (r.title) lines.push(r.title);
  if (r.subtitle) lines.push(r.subtitle);
  if (lines.length === 0) lines.push(r.place_id);
  return {
    place_id: r.place_id,
    title: r.title || r.place_id,
    subtitle: r.subtitle || '',
    address_lines: lines,
    lat: r.lat,
    lon: r.lon,
    kind: r.source,
  };
}

function isLocatable(p: PlaceResult): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

// ── Component ──────────────────────────────────────────────────

export interface SearchPanelProps {
  viewportCenter: ViewportCenter | null;
  onSelect: (place: PlaceResult) => void;
  onHover?: (place: PlaceResult | null) => void;
  onClose: () => void;
}

const SearchPanel: React.FC<SearchPanelProps> = ({
  viewportCenter,
  onSelect,
  onHover,
  onClose,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<number>(-1);
  const [fallbackUsed, setFallbackUsed] = useState(false);
  const [offline, setOffline] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = useCallback(
    async (text: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const trimmed = text.trim();
      if (!trimmed) {
        setResults([]);
        setError('');
        setFallbackUsed(false);
        setOffline(false);
        setBusy(false);
        return;
      }
      setBusy(true);
      setError('');
      try {
        const response = await searchPlaces(trimmed, viewportCenter, controller.signal);
        setResults(response.results);
        setFallbackUsed(response.fallback_used);
        setOffline(response.offline);
        setCursor(response.results.length > 0 ? 0 : -1);
        if (response.results.length === 0 && !response.offline) {
          setError(`No matches for "${trimmed}"`);
        }
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setResults([]);
        setFallbackUsed(false);
        setOffline(false);
        setError(e instanceof Error ? e.message : 'Search failed');
      } finally {
        setBusy(false);
      }
    },
    [viewportCenter],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      abortRef.current?.abort();
      setResults([]);
      setError('');
      setBusy(false);
      setCursor(-1);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void run(query);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, run]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const commit = useCallback(
    (place: PlaceResult) => {
      onHover?.(null);
      onSelect(place);
    },
    [onHover, onSelect],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c <= 0 ? results.length - 1 : c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const idx = cursor >= 0 ? cursor : 0;
      const picked = results[idx];
      if (picked) commit(picked);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) {
        setQuery('');
      } else {
        onClose();
      }
    }
  };

  const helper = useMemo(() => {
    if (busy) return 'Searching…';
    if (error) return error;
    if (!query.trim()) return 'Try an address, city, or ZIP.';
    return '';
  }, [busy, error, query]);

  return (
    <section
      role="tabpanel"
      aria-label="Search places"
      className="flex h-full w-full flex-col gap-3 p-4"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Search</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-card"
        >
          <X size={16} />
        </button>
      </header>

      <div className="relative">
        {busy ? (
          <Loader2
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin"
          />
        ) : (
          <SearchIcon
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
        )}
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search Maps"
          aria-label="Search Maps"
          className="pl-9 pr-9 h-11 rounded-full border-border/40 bg-card"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {helper && (
        <div className="px-1 text-xs text-muted-foreground">{helper}</div>
      )}

      {fallbackUsed && results.length > 0 && (
        <div
          role="status"
          className="mx-1 rounded-md border border-border/40 bg-card/60 px-2 py-1 text-[11px] text-muted-foreground"
        >
          Using online search for this area — install a region for offline results.
        </div>
      )}

      {offline && query.trim() && !busy && (
        <div
          role="status"
          className="mx-1 flex items-start gap-2 rounded-md border border-border/40 bg-card/60 px-3 py-2 text-xs text-muted-foreground"
        >
          <MapPin size={14} className="mt-0.5 shrink-0" />
          <span>
            No offline results for this area. Install a region to search here offline.
          </span>
        </div>
      )}

      {results.length > 0 && (
        <ul
          role="listbox"
          aria-label="Search results"
          className="flex flex-col divide-y divide-border/20 overflow-y-auto rounded-xl border border-border/30 bg-card/60"
        >
          {results.map((r, idx) => (
            <li key={r.place_id}>
              <button
                type="button"
                role="option"
                aria-selected={cursor === idx}
                onClick={() => commit(r)}
                onMouseEnter={() => {
                  setCursor(idx);
                  onHover?.(r);
                }}
                onMouseLeave={() => onHover?.(null)}
                className={cn(
                  'flex w-full items-start gap-3 px-3 py-3 text-left transition-colors',
                  cursor === idx ? 'bg-primary/10' : 'hover:bg-card',
                )}
              >
                <MapPin
                  size={16}
                  className="mt-0.5 shrink-0 text-primary-foreground"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {r.title}
                  </div>
                  {r.subtitle && (
                    <div className="truncate text-xs text-muted-foreground">
                      {r.subtitle}
                    </div>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default SearchPanel;
