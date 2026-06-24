import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

import { poiBgColorFromCategory } from "../poi-colors";
import { poiCategoryIconId } from "../poi-icons";
import { poiLucideIcon } from "../poi-lucide-icons";
import { isResidentialPlace } from "../residential";
import { loadSatelliteSnapshot, peekSatelliteSnapshot } from "../satellite-snapshot";
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

  // Double-buffer cross-fade. On every place change the bottom layer (current
  // image) starts fading out immediately; the new image loads into the top layer
  // and fades in over whatever's left, then is promoted to the bottom. An opaque
  // image fading 0→100 over another reads as a smooth cross-fade; with no new
  // photo the bottom just finishes fading out to the placeholder icon.
  const [bottomPhoto, setBottomPhoto] = useState<string | null>(null);
  const [bottomOn, setBottomOn] = useState(true);
  const [topPhoto, setTopPhoto] = useState<string | null>(null);
  const [topLoaded, setTopLoaded] = useState(false);
  // Logo only shown after fetch resolves with no photo — never during loading.
  const [fetchDone, setFetchDone] = useState(false);
  const swapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const iconId = poiCategoryIconId(place.kind ?? null);
  const Icon = poiLucideIcon(iconId);
  const bg = poiBgColorFromCategory(place.kind);

  useEffect(() => {
    setLogoStage(brandSrc ? "brand" : favSrc ? "favicon" : "none");
    setLogoVisible(false);
  }, [place.place_id, brandSrc, favSrc]);

  useEffect(() => {
    // Tile preliminaries have no real identity yet — leave the current image and
    // any in-flight fetch untouched, don't fetch or flash the icon.
    if (place.place_id.startsWith("tile:")) return;

    if (swapTimerRef.current) clearTimeout(swapTimerRef.current);
    if (fadeOutTimerRef.current) clearTimeout(fadeOutTimerRef.current);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Start fading the current image out *immediately* so selecting a new POI
    // registers at once — we don't wait for the new image to load (that made it
    // look like nothing happened). The new one cross-fades in over it once ready;
    // if it's slow, the old finishes fading to the gradient/icon in the meantime.
    setTopPhoto(null);
    setTopLoaded(false);
    setFetchDone(false);
    setBottomOn(false);
    fadeOutTimerRef.current = setTimeout(() => {
      setBottomPhoto(null);
      setBottomOn(true);
    }, 700);

    // New photo found → load it into the top layer; handleTopLoad fades it in and
    // promotes it to the bottom (always after the fade-out above has reset).
    const fadeIn = (url: string): void => {
      if (controller.signal.aborted) return;
      setTopPhoto(url);
      setTopLoaded(false);
      setFetchDone(true);
    };
    // No photo → the old image is already fading out; let the icon follow.
    const noPhoto = (): void => {
      if (controller.signal.aborted) return;
      setFetchDone(true);
    };

    const cached = resolvedPhotoCache.get(place.place_id);
    if (cached) {
      fadeIn(cached);
      return () => { controller.abort(); };
    }

    // Homes have no Wikipedia entry — stitch a satellite snapshot of the lot.
    if (isResidentialPlace(place)) {
      const memo = peekSatelliteSnapshot(place.place_id);
      if (memo) {
        fadeIn(memo);
        return () => { controller.abort(); };
      }
      void loadSatelliteSnapshot(place.place_id, place.lat, place.lon).then((url) => {
        if (url) fadeIn(url);
        else noPhoto(); // offline / no tiles
      });
      return () => { controller.abort(); };
    }

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
      const photo = wikiUrl ?? wikidataUrl ?? searchUrl ?? null;
      if (photo) {
        resolvedPhotoCache.set(place.place_id, photo);
        _persistCache(resolvedPhotoCache);
        void _cacheLocally(place.place_id, photo);
        fadeIn(photo);
      } else {
        noPhoto();
      }
    });

    return () => {
      if (swapTimerRef.current) clearTimeout(swapTimerRef.current);
      if (fadeOutTimerRef.current) clearTimeout(fadeOutTimerRef.current);
      controller.abort();
    };
  }, [place.place_id, place.wiki_url, place.brand_qid, place.title]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleTopLoad() {
    setTopLoaded(true); // incoming fades in over the current image → cross-fade
    swapTimerRef.current = setTimeout(() => {
      // Promote the now fully-faded-in image to the stable bottom layer. It's at
      // full opacity already, so this hand-off is seamless (no re-fade).
      setBottomPhoto(topPhoto);
      setBottomOn(true);
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

      {/* Bottom layer: the current image. Holds while a new one loads, then
          dissolves out (bottomOn=false) when the next place has no photo. */}
      {bottomPhoto ? (
        <img
          src={bottomPhoto}
          alt=""
          aria-hidden
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-700",
            bottomOn ? "opacity-100" : "opacity-0",
          )}
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
