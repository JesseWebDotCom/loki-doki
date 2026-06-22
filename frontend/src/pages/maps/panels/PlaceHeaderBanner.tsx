import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

import { poiBgColorFromCategory } from "../poi-colors";
import { poiCategoryIconId } from "../poi-icons";
import { poiLucideIcon } from "../poi-lucide-icons";
import type { PlaceResult } from "../types";

// ── image fetchers ────────────────────────────────────────────────────────────

function extractWikiTitle(wikiUrl: string | null | undefined): string | null {
  if (!wikiUrl) return null;
  try {
    const u = new URL(wikiUrl);
    if (!u.hostname.includes("wikipedia.org")) return null;
    const m = u.pathname.match(/\/wiki\/(.+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function wikiNorm(s: string): string {
  return s.toLowerCase().replace(/[''`]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isRelevantTitle(poiName: string, articleTitle: string): boolean {
  const a = wikiNorm(articleTitle);
  const b = wikiNorm(poiName);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

async function fetchWikiSummaryPhoto(title: string, signal: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { signal },
    );
    if (!r.ok) return null;
    const d = (await r.json()) as { type?: string; thumbnail?: { source?: string } };
    if (d.type === "disambiguation") return null;
    return d.thumbnail?.source ?? null;
  } catch {
    return null;
  }
}

// Path 1: direct wiki_url on the POI (most accurate)
function fetchWikiUrlPhoto(
  wikiUrl: string | null | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  const title = extractWikiTitle(wikiUrl);
  return title ? fetchWikiSummaryPhoto(title, signal) : Promise.resolve(null);
}

// Path 2: brand_qid → Wikidata English Wikipedia sitelink → thumbnail
async function fetchWikidataPhoto(qid: string, signal: AbortSignal): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      action: "wbgetentities",
      ids: qid,
      props: "sitelinks",
      sitelinks: "enwiki",
      format: "json",
      origin: "*",
    });
    const r = await fetch(`https://www.wikidata.org/w/api.php?${params}`, { signal });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }>;
    };
    const title = d.entities?.[qid]?.sitelinks?.enwiki?.title;
    return title ? fetchWikiSummaryPhoto(title, signal) : null;
  } catch {
    return null;
  }
}

// Path 3: Wikipedia name search → thumbnail of first relevant result
async function fetchWikiSearchPhoto(
  name: string,
  kind: string | null,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const kindWord = kind ? (kind.split(":").pop() ?? kind).replace(/_/g, " ").trim() : null;
    const query = kindWord ? `${name} ${kindWord}` : name;
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: "1",
      format: "json",
      origin: "*",
    });
    const sr = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { signal });
    if (!sr.ok) return null;
    const sd = (await sr.json()) as { query?: { search?: { title: string }[] } };
    const hit = sd.query?.search?.[0];
    if (!hit || !isRelevantTitle(name, hit.title)) return null;
    return fetchWikiSummaryPhoto(hit.title, signal);
  } catch {
    return null;
  }
}

// localStorage-backed cache: place_id → local API URL (or Wikipedia URL before local is ready).
const LS_KEY = "maps:poi-photos:2";
function _loadCache(): Map<string, string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return new Map(JSON.parse(raw) as [string, string][]);
  } catch { /* ignore */ }
  return new Map();
}
function _persistCache(cache: Map<string, string>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...cache.entries()].slice(-300)));
  } catch { /* ignore */ }
}
const resolvedPhotoCache = _loadCache();

function _localUrl(key: string): string {
  return `/api/maps/poi-photo/${key}`;
}

async function _cacheLocally(key: string, wikiUrl: string): Promise<void> {
  try {
    const resp = await fetch("/api/maps/poi-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, url: wikiUrl }),
    });
    if (resp.ok) {
      resolvedPhotoCache.set(key, _localUrl(key));
      _persistCache(resolvedPhotoCache);
    }
  } catch { /* ignore */ }
}

function faviconUrl(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);
    return `/api/maps/favicon?host=${encodeURIComponent(url.hostname)}`;
  } catch {
    return null;
  }
}

// ── component ─────────────────────────────────────────────────────────────────

export function PlaceHeaderBanner({ place }: { place: PlaceResult }): JSX.Element {
  const brandSrc = place.brand_qid ? `/api/maps/logos/${place.brand_qid}.png` : null;
  const favSrc = faviconUrl(place.website);

  type LogoStage = "brand" | "favicon" | "none";
  const [logoStage, setLogoStage] = useState<LogoStage>(
    brandSrc ? "brand" : favSrc ? "favicon" : "none",
  );
  const [logoVisible, setLogoVisible] = useState(false);

  // Double-buffer cross-fade: bottom stays fully visible while top loads in.
  // Lazy init from cache so hasPhoto=true on first render for repeat visits.
  const [bottomPhoto, setBottomPhoto] = useState<string | null>(() => resolvedPhotoCache.get(place.place_id) ?? null);
  const [topPhoto, setTopPhoto] = useState<string | null>(null);
  const [topLoaded, setTopLoaded] = useState(false);
  // Logo only shown after fetch resolves with no photo — never during loading.
  const [fetchDone, setFetchDone] = useState(() => !!resolvedPhotoCache.get(place.place_id));
  const swapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const iconId = poiCategoryIconId(place.kind ?? null);
  const Icon = poiLucideIcon(iconId);
  const bg = poiBgColorFromCategory(place.kind);

  useEffect(() => {
    setLogoStage(brandSrc ? "brand" : favSrc ? "favicon" : "none");
    setLogoVisible(false);
  }, [place.place_id, brandSrc, favSrc]);

  useEffect(() => {
    if (swapTimerRef.current) clearTimeout(swapTimerRef.current);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Skip remote photo fetches for tile preliminaries — no real identity yet.
    // Keep fetchDone=false so the logo never flashes during this brief phase.
    if (place.place_id.startsWith("tile:")) {
      setTopPhoto(null);
      setTopLoaded(false);
      setBottomPhoto(null);
      setFetchDone(false);
      return () => { controller.abort(); };
    }

    // Cached from this session — show immediately, logo never appears.
    const cached = resolvedPhotoCache.get(place.place_id);
    if (cached) {
      setBottomPhoto(cached);
      setTopPhoto(null);
      setTopLoaded(false);
      setFetchDone(true);
      return () => { controller.abort(); };
    }

    // Immediately wipe both layers so the previous POI's photo never bleeds through.
    setTopPhoto(null);
    setTopLoaded(false);
    setBottomPhoto(null);
    setFetchDone(false);

    // Run all three paths in parallel; pick best available by priority.
    void Promise.all([
      fetchWikiUrlPhoto(place.wiki_url, controller.signal),
      place.brand_qid
        ? fetchWikidataPhoto(place.brand_qid, controller.signal)
        : Promise.resolve(null),
      place.kind === "residential" || /^\d/.test(place.title)
        ? Promise.resolve(null)
        : fetchWikiSearchPhoto(place.title, place.kind ?? null, controller.signal),
    ]).then(([wikiUrl, wikidataUrl, searchUrl]) => {
      if (controller.signal.aborted) return;
      const photo = wikiUrl ?? wikidataUrl ?? searchUrl ?? null;
      if (photo) {
        resolvedPhotoCache.set(place.place_id, photo);
        _persistCache(resolvedPhotoCache);
        setTopPhoto(photo);
        setTopLoaded(false);
        void _cacheLocally(place.place_id, photo);
      }
      // Only now allow logo to appear — and only if no photo was found.
      setFetchDone(true);
    });

    return () => {
      if (swapTimerRef.current) clearTimeout(swapTimerRef.current);
      controller.abort();
    };
  }, [place.place_id, place.wiki_url, place.brand_qid, place.title]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleTopLoad() {
    setTopLoaded(true);
    swapTimerRef.current = setTimeout(() => {
      setBottomPhoto(topPhoto);
      setTopPhoto(null);
      setTopLoaded(false);
    }, 750);
  }

  const logoSrc =
    logoStage === "brand" ? brandSrc : logoStage === "favicon" ? favSrc : null;
  const hasPhoto = !!(bottomPhoto || (topPhoto && topLoaded));
  // Logo/icon only renders after fetch completes AND no photo was found.
  const showFallback = fetchDone && !hasPhoto;

  return (
    <div className="relative h-44 w-full shrink-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{ background: `radial-gradient(ellipse at 60% 35%, ${bg}88 0%, ${bg} 100%)` }}
      />

      {/* Logo or category icon — only shown when fetch is done and no photo found */}
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-opacity duration-500",
          showFallback ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
      >
        {logoSrc ? (
          <span className="flex size-20 items-center justify-center rounded-full bg-white shadow-lg overflow-hidden">
            <img
              src={logoSrc}
              alt=""
              aria-hidden
              className={cn(
                "size-full object-contain p-2",
                logoVisible ? "opacity-100" : "opacity-0",
              )}
              onLoad={() => setLogoVisible(true)}
              onError={() => {
                if (logoStage === "brand" && favSrc) {
                  setLogoStage("favicon");
                } else {
                  setLogoStage("none");
                }
                setLogoVisible(false);
              }}
            />
          </span>
        ) : (
          <Icon className="size-24 text-white/30" strokeWidth={1} />
        )}
      </div>

      {/* Bottom layer: stable fully-visible photo */}
      {bottomPhoto ? (
        <img
          src={bottomPhoto}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => {
            resolvedPhotoCache.delete(place.place_id);
            _persistCache(resolvedPhotoCache);
            setBottomPhoto(null);
          }}
        />
      ) : null}

      {/* Top layer: incoming photo cross-fades over the bottom */}
      {topPhoto ? (
        <img
          src={topPhoto}
          alt=""
          aria-hidden
          onLoad={handleTopLoad}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-700",
            topLoaded ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/30 to-transparent" />
    </div>
  );
}
