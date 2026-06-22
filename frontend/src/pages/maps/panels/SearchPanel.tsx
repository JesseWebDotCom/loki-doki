import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ExternalLinkIcon, Loader2Icon, LocateFixedIcon, LocateOffIcon, PhoneIcon, SearchIcon, WifiOffIcon, XIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

import { searchPlaces, type ViewportCenter } from "../api";
import { filterAndDedupePoiResults } from "../poi-filters";
import { PoiIcon } from "../PoiIcon";
import type { PlaceResult } from "../types";
import { useUserLocation } from "../use-user-location";
import { PlaceDetailsCard } from "./PlaceDetailsCard";
import { RecentsList } from "./RecentsList";

const DEBOUNCE_MS = 300;

export function SearchPanel({
  viewportCenter,
  initialQuery,
  initialCategory,
  onSelect,
  onClose,
  recentsReloadKey,
  selectedPlace,
  onDeselectPlace,
  onDirections,
}: {
  viewportCenter: ViewportCenter | null;
  initialQuery?: string;
  initialCategory?: string | null;
  onSelect: (place: PlaceResult) => void;
  onClose?: () => void;
  recentsReloadKey?: number;
  selectedPlace?: PlaceResult | null;
  onDeselectPlace?: () => void;
  onDirections?: (place: PlaceResult) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [error, setError] = useState("");
  const [fallbackUsed, setFallbackUsed] = useState(false);
  const [offline, setOffline] = useState(false);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [results, setResults] = useState<PlaceResult[]>([]);
  // Hides the results popover after a pick without clearing `query`,
  // so re-focusing the input can re-show them without re-typing.
  const [dismissed, setDismissed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popoverWrapRef = useRef<HTMLDivElement | null>(null);
  // viewportCenter changes on every map moveend. Reading it through a
  // ref keeps the debounce effect's deps to (query, initialCategory)
  // so map pans don't tear down the in-flight typing debounce.
  const viewportCenterRef = useRef(viewportCenter);
  useEffect(() => {
    viewportCenterRef.current = viewportCenter;
  }, [viewportCenter]);
  const userLocation = useUserLocation();
  const userLocationRef = useRef(userLocation.location);
  useEffect(() => {
    userLocationRef.current = userLocation.location;
  }, [userLocation.location]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim() && !initialCategory) {
      abortRef.current?.abort();
      setBusy(false);
      setCursor(-1);
      setError("");
      setResults([]);
      return undefined;
    }
    const handle = window.setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const trimmed = query.trim();
      setBusy(true);
      setError("");
      try {
        const viewport = viewportCenterRef.current;
        const near = userLocationRef.current ?? viewport;
        const response = await searchPlaces(trimmed, viewport, controller.signal, {
          category: initialCategory ?? undefined,
          near,
        });
        if (controller.signal.aborted) return;
        setResults(filterAndDedupePoiResults(response.results));
        setFallbackUsed(response.fallback_used);
        setOffline(response.offline);
        setCursor(response.results.length > 0 ? 0 : -1);
        if (response.results.length === 0 && !response.offline) {
          setError(`No matches for "${trimmed}"`);
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setResults([]);
        setFallbackUsed(false);
        setOffline(false);
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, initialCategory]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (dismissed || results.length === 0) return undefined;
    function onDocPointerDown(event: PointerEvent): void {
      const wrap = popoverWrapRef.current;
      if (wrap && !wrap.contains(event.target as Node)) {
        setDismissed(true);
      }
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [dismissed, results.length]);

  const helper = useMemo(() => {
    if (busy) return "Searching...";
    if (offline) return "Offline fallback unavailable here.";
    if (error) return error;
    if (!query.trim() && !initialCategory) return "Try an address, city, or ZIP.";
    if (fallbackUsed) return "Online fallback used outside installed coverage.";
    return "";
  }, [busy, error, fallbackUsed, initialCategory, offline, query]);

  function commit(place: PlaceResult): void {
    setDismissed(true);
    onSelect(place);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (results.length === 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (query) {
          setQuery("");
        } else {
          onClose?.();
        }
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((current) => (current <= 0 ? results.length - 1 : current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const pick = results[cursor >= 0 ? cursor : 0];
      if (pick) commit(pick);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query) {
        setQuery("");
      } else {
        onClose?.();
      }
    }
  }

  const showRecents =
    dismissed || (!query.trim() && !initialCategory && results.length === 0);
  const showHelper = Boolean(helper);

  return (
    <section
      role="tabpanel"
      aria-label="Search places"
      className="grid gap-3"
    >
      <div ref={popoverWrapRef} className="relative">
        {busy ? (
          <Loader2Icon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-foreground/60" />
        ) : (
          <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground/60" />
        )}
        <Input
          ref={inputRef}
          placeholder="Search Maps"
          value={query}
          onChange={(event) => {
            setDismissed(false);
            setQuery(event.target.value);
          }}
          onFocus={() => setDismissed(false)}
          onKeyDown={onKeyDown}
          className="rounded-xl border-border/60 bg-background/70 pl-9 pr-9 text-sm"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setDismissed(false);
              setQuery("");
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-foreground/60 hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
        {results.length > 0 && !dismissed ? (
          <div
            role="dialog"
            aria-label="Search results"
            className="absolute left-0 right-0 top-full z-30 mt-2 max-h-[60vh] overflow-y-auto rounded-2xl border border-border/60 bg-popover p-2 shadow-xl"
          >
            <ul role="listbox" className="grid gap-1">
              {results.map((place, index) => {
                const subtitle = place.subtitle?.trim() || formatCoords(place.lat, place.lon);
                const distance = place.distance_m ? formatDistance(place.distance_m) : null;
                return (
                  <li
                    key={place.place_id}
                    role="option"
                    aria-selected={index === cursor}
                    onMouseEnter={() => setCursor(index)}
                    className={cn(
                      "rounded-xl transition-colors",
                      index === cursor ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => commit(place)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
                    >
                      <PoiIcon kind={place.kind} brand_qid={place.brand_qid} website={place.website} />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate text-sm font-medium">{place.title}</span>
                        <span className="truncate text-xs text-foreground/60">
                          {distance ? `${distance} · ${subtitle}` : subtitle}
                        </span>
                        {place.open_now != null ? (
                          <span className={cn("text-[11px] font-medium", place.open_now ? "text-emerald-500" : "text-rose-500/80")}>
                            {place.open_now
                              ? (place.closes_at ? `Open · Closes ${place.closes_at}` : "Open now")
                              : (place.opens_at ? `Closed · Opens ${place.opens_at}` : "Closed")}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {(place.phone || place.website) ? (() => {
                      const telHref = place.phone ? `tel:${place.phone.replace(/[^\d+\-.() ]/g, "")}` : null;
                      const websiteHref = safeHttpUrl(place.website);
                      return (telHref || websiteHref) ? (
                        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
                          {telHref ? (
                            <Badge asChild variant="outline" className="gap-1 text-[11px]">
                              <a href={telHref}>
                                <PhoneIcon className="size-3" />
                                {place.phone}
                              </a>
                            </Badge>
                          ) : null}
                          {websiteHref ? (
                            <Badge asChild variant="outline" className="gap-1 text-[11px]">
                              <a href={websiteHref} target="_blank" rel="noopener noreferrer">
                                <ExternalLinkIcon className="size-3" />
                                Website
                              </a>
                            </Badge>
                          ) : null}
                        </div>
                      ) : null;
                    })() : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
      {selectedPlace && !query.trim() ? (
        <PlaceDetailsCard
          place={selectedPlace}
          onClose={onDeselectPlace ?? (() => {})}
          onDirections={onDirections ?? (() => {})}
        />
      ) : (
        <>
          {showHelper ? <p className="text-xs text-foreground/60">{helper}</p> : null}
          {userLocation.status === "granted" ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-foreground/55">
              <LocateFixedIcon className="size-3.5 text-emerald-500" />
              Using your location for ranking
            </p>
          ) : userLocation.status === "denied" ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-foreground/55">
              <LocateOffIcon className="size-3.5 text-amber-500" />
              Location off — ranking by map view
            </p>
          ) : null}
        </>
      )}
      {offline ? (
        <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/60 px-3 py-1 text-xs text-foreground/70">
          <WifiOffIcon className="size-3.5" />
          Offline
        </div>
      ) : null}
      {showRecents ? (
        <div className="grid gap-2">
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-foreground/55">
            Recents
          </p>
          <RecentsList
            flat
            variant="places"
            reloadKey={recentsReloadKey}
            onPick={onSelect}
          />
        </div>
      ) : null}
    </section>
  );
}


function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function formatDistance(distanceM: number): string {
  if (distanceM >= 1609.344) {
    return `${(distanceM / 1609.344).toFixed(1)} mi`;
  }
  return `${Math.round(distanceM)} m`;
}

/**
 * Validates that a URL uses http: or https:, returning the original string
 * (not url.href which appends a trailing slash). Scheme-less values like
 * "example.com" are assumed https and re-validated. Returns null for
 * javascript:, data:, or unparseable values.
 */
function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return trimmed;
  } catch {
    // Scheme-less OSM value like "example.com" — assume https and re-validate.
    try {
      const url = new URL(`https://${trimmed}`);
      if (url.protocol !== "https:") return null;
      return `https://${trimmed}`;
    } catch {
      return null;
    }
  }
}

