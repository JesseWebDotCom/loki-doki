/**
 * Search panel — the "Search" left-rail item's main pane.
 *
 * The fetch target is abstracted into `searchPlaces()` so Chunk 5 can
 * swap it for `/api/v1/maps/geocode` (offline FTS5) without touching
 * any feature code below. Today it hits Nominatim directly, matching
 * the behavior the old floating search bar had.
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

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const MAX_RESULTS = 5;
const DEBOUNCE_MS = 300;

export interface ViewportCenter {
  lng: number;
  lat: number;
}

/**
 * Single callsite for place search. Today: online Nominatim. Chunk 5
 * swaps the implementation to hit `/api/v1/maps/geocode` when an
 * offline region covers `viewportCenter`.
 */
export async function searchPlaces(
  query: string,
  _viewportCenter: ViewportCenter | null,
  signal: AbortSignal,
): Promise<PlaceResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(MAX_RESULTS));
  url.searchParams.set('addressdetails', '1');

  const res = await fetch(url.toString(), {
    signal,
    headers: { 'Accept-Language': navigator.language || 'en' },
  });
  if (!res.ok) throw new Error(`Geocoder ${res.status}`);
  const raw = (await res.json()) as NominatimRaw[];
  return raw.map(toPlaceResult).filter(isLocatable);
}

interface NominatimRaw {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
  address?: Record<string, string | undefined>;
}

function toPlaceResult(r: NominatimRaw): PlaceResult {
  const [head, ...tail] = r.display_name.split(', ');
  const addr = r.address ?? {};
  const lines: string[] = [];
  const line1 = [addr['house_number'], addr['road']].filter(Boolean).join(' ');
  if (line1) lines.push(line1);
  const city = addr['city'] || addr['town'] || addr['village'] || addr['hamlet'];
  const region = addr['state'] || addr['region'];
  const cityRegion = [city, region, addr['postcode']].filter(Boolean).join(', ');
  if (cityRegion) lines.push(cityRegion);
  if (addr['country']) lines.push(addr['country']);
  if (lines.length === 0) lines.push(r.display_name);

  return {
    place_id: String(r.place_id),
    title: head ?? r.display_name,
    subtitle: tail.join(', '),
    address_lines: lines,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    kind: r.type || r.class,
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
        setBusy(false);
        return;
      }
      setBusy(true);
      setError('');
      try {
        const found = await searchPlaces(trimmed, viewportCenter, controller.signal);
        setResults(found);
        setCursor(found.length > 0 ? 0 : -1);
        if (found.length === 0) setError(`No matches for "${trimmed}"`);
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setResults([]);
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
