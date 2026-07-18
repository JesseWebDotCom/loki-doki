import {
  Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity, Bookmark, BookOpen, CalendarDays, CirclePlay, CloudSun, Gauge, Heart, Headphones, Home, Laugh, LayoutGrid,
  Lightbulb, ListVideo, LockOpen, Music, Newspaper, Pencil, Play, PlaySquare, Plus,
  Power, RotateCw, Search, ShieldCheck, Star, Sunrise, Tag, Trophy, Tv, Upload, Volume2, X, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cardVariants } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/lib/toast";
import type { VideoItem } from "@/lib/youtube/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DeviceCard, type CardAction } from "@/components/homeassistant/DeviceCard";
import type { HAEntity } from "@/components/homeassistant/DeviceDetailDialog";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  pointerWithin,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type CollisionDetection,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { NewsRow, NewsLink, NewsThumb, type NewsItem } from "@/components/shared/NewsCard";
import { SectionHeader } from "@/components/shared/SectionHeader";
import { ArtBillboard, type ArtBillboardItem } from "@/components/shared/ArtBillboard";
import { useNewsReaderMode } from "@/hooks/useNewsReaderMode";
import { usePublishUIContext } from "@/context/UIContextProvider";
import { useAuth } from "@/context/AuthContext";
import { useWeatherSnapshot } from "@/hooks/useWeatherSnapshot";
import { useHomeLayout, resolveTickerConfig, type HomeRow, type HomeWidget, type TickerConfig, type TickerSource } from "@/hooks/useHomeLayout";
import { weatherIconSrc, currentMoonPhase, moonPhaseInfo, heroBackground, heroTextClass, SNOW_TEXT, type HeroGradient } from "@/lib/weather";
import { WeatherHeroBg } from "@/components/weather/WeatherHeroBg";
import { getWidgetMeta, canonicalWidgetId, type WidgetMeta } from "@/lib/homeWidgets";
import { WidgetGalleryModal } from "@/components/home/WidgetGalleryModal";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { DownloadsWidget } from "@/components/home/DownloadsWidget";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSpotlight } from "@/components/shared/SpotlightSearch";
import { useYtFeed } from "@/lib/youtube/useData";
import { fmtAge, thumbUrl } from "@/lib/youtube/format";
import { ytImageProxy } from "@/lib/youtube/api";
import { proxyImg } from "@/lib/img";
import { ytItemToHub } from "@/components/videos/HubCard";
import { VIDEO_CATEGORIES } from "@/lib/videos/categories";
import { HUB_PATHS } from "@/components/videos/HubVideoCard";
import { SOURCE_META } from "@/lib/videos/sources";
import { getFollowingFeed, getHubHistory, type HubVideoItem } from "@/lib/videos/api";
import { getHistory as getYtHistory } from "@/lib/youtube/api";
import { getHistory, getFavorites, listStations, stationToDj, type Station } from "@/lib/music/catalogApi";
import { useRadio } from "@/context/RadioContext";
import { usePodcastFeed, continueListening, newEpisodes, type FeedEpisode } from "@/lib/podcast/useFeed";
import { coverUrl } from "@/lib/podcast/api";
import { usePodcastPlayback } from "@/context/PodcastPlaybackContext";
import { useYoutubePlayback } from "@/context/YoutubePlaybackContext";
import type { BookmarkItem } from "@/lib/bookmarks/api";
import { useInstalledTools } from "@/hooks/useInstalledTools";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { WidgetErrorBoundary } from "@/components/shared/WidgetErrorBoundary";
import {
  DEFAULT_THRESHOLDS, RATING_META, fmtMbps, fmtMs, loadLastResults, loadThresholds,
  rateSpeed, runSpeedTest, saveLastResult, type SpeedMode, type SpeedPhase, type SpeedResult,
  type SpeedThresholds,
} from "@/lib/speedtest";
import { cn } from "@/lib/cn";

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS   = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// ── Types ─────────────────────────────────────────────────────────────────────

interface OtdItem   { title: string }
interface GameItem  { title: string }

// ── Compact weather widget (header) ──────────────────────────────────────────

function WeatherWidget({ light, variant = "corner" }: { light?: boolean; variant?: "corner" | "strip" }) {
  const { snapshot, status } = useWeatherSnapshot();
  const moon = moonPhaseInfo(currentMoonPhase());
  const isDay = snapshot?.isDay ?? true;

  const textMuted = light ? "text-white/80" : "text-muted-foreground";
  const textFaint = light ? "text-white/55" : "text-muted-foreground/50";

  if (status === "loading") {
    return <Spinner className={light ? "text-white/40" : "text-muted-foreground/30"} />;
  }

  if (status !== "ready" || !snapshot) {
    return (
      <Link to="/weather" className={cn("flex", variant === "strip" ? "items-center gap-2" : "flex-col items-end")}>
        <span className="text-2xl leading-none">⛅</span>
        <p className={cn("text-[11px]", variant === "strip" ? "" : "mt-0.5", textMuted)}>Weather</p>
      </Link>
    );
  }

  // Mobile: a full-width horizontal strip so the description reads on its own line
  // (the corner layout right-hugs it into ~130px).
  if (variant === "strip") {
    return (
      <Link
        to="/weather"
        className="flex items-center gap-3 rounded-card border border-border/40 bg-card/60 px-4 py-2.5"
      >
        <div className="relative shrink-0">
          <img src={weatherIconSrc(snapshot.info.icon)} className="size-11" alt="" />
          {!isDay && (
            <span className="absolute -top-0.5 -right-1 text-xs leading-none"
              style={{ filter: "drop-shadow(0 0 4px rgba(147,197,253,0.9))" }}>
              {moon.emoji}
            </span>
          )}
        </div>
        <span className={cn("text-[2rem] font-semibold tracking-tight tabular-nums leading-none", light && "text-white drop-shadow")}>
          {snapshot.temp}°
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-medium capitalize", textMuted)}>{snapshot.info.desc}</p>
          <p className={cn("truncate text-xs leading-tight", textFaint)}>{snapshot.location}</p>
        </div>
      </Link>
    );
  }

  return (
    <Link to="/weather" className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-2">
        <div className="relative shrink-0">
          <img src={weatherIconSrc(snapshot.info.icon)} className="size-12" alt="" />
          {!isDay && (
            <span className="absolute -top-0.5 -right-1 text-xs leading-none"
              style={{ filter: "drop-shadow(0 0 4px rgba(147,197,253,0.9))" }}>
              {moon.emoji}
            </span>
          )}
        </div>
        <span className={cn("text-[2rem] font-semibold tracking-tight tabular-nums leading-none", light && "text-white drop-shadow")}>{snapshot.temp}°</span>
      </div>
      <p className={cn("text-xs font-medium", textMuted)}>{snapshot.info.desc}</p>
      <p className={cn("text-[10px] max-w-[130px] text-right leading-tight truncate", textFaint)}>
        {snapshot.location}
      </p>
    </Link>
  );
}

// ── Joke text (inline below greeting) ────────────────────────────────────────

function JokeText({ light }: { light?: boolean }) {
  const [joke, setJoke] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/jokes", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { joke?: string | null } | null) => { setJoke(d?.joke ?? null); })
      .catch(() => {});
  }, []);

  if (!joke) return null;
  return (
    <p className={cn("mt-2.5 text-[13px] italic leading-snug", light ? "text-white/70" : "text-muted-foreground/55")}>
      {joke}
    </p>
  );
}

// ── Home ticker (multi-source) ────────────────────────────────────────────────

interface ParsedGame { league: string; teams: string; status: string; isFinal: boolean; isLive: boolean }

function parseGame(title: string): ParsedGame {
  const colonIdx = title.indexOf(":");
  const league = colonIdx >= 0 ? title.slice(0, colonIdx).trim() : "";
  const rest   = colonIdx >= 0 ? title.slice(colonIdx + 1).trim() : title;
  const paren  = rest.match(/\(([^)]+)\)\s*$/);
  const rawStatus = paren ? paren[1]!.trim() : "";
  const teams  = paren ? rest.slice(0, paren.index).trim() : rest;
  const isFinal = /^final$/i.test(rawStatus);
  const isLive  = /live|\bQ\d\b|halftime|OT\b/i.test(rawStatus);
  const status  = rawStatus.replace(/ - /g, " · ").replace(/ [A-Z]{2,3}$/, "");
  return { league, teams, status, isFinal, isLive };
}

const RESUME_DELAY_MS = 3000;
const FRICTION = 0.92;
const MIN_MOMENTUM = 0.008;

type TickerItem =
  | { type: 'sports'; title: string }
  | { type: 'youtube'; videoId: string; title: string; channelThumb?: string | null; localKind?: 'audio' | 'video' }
  | { type: 'news'; title: string; url?: string | null; imageUrl?: string | null; faviconHost?: string | null }
  | { type: 'podcast'; episodeId: string; showId: string; showName: string; title: string; podCoverUrl: string; durationSec?: number | null; chapters?: { title: string; startSec: number }[] }

type TickerSection = { source: TickerSource; items: TickerItem[] }

// One calm, neutral tone for every source. A row of four different accent hues in
// a 30px strip read as a dashboard ticker, not a media app; the icon alone carries
// the source, the label the context (see Visual Language: accent discipline).
const SECTION_STYLES: Record<TickerSource, { Icon: React.ElementType; accent: string; bg: string; label: string }> = {
  sports:  { Icon: Trophy,      accent: 'text-muted-foreground/70', bg: '', label: 'Scores'   },
  youtube: { Icon: PlaySquare,  accent: 'text-muted-foreground/70', bg: '', label: 'YouTube'  },
  news:    { Icon: Newspaper,   accent: 'text-muted-foreground/70', bg: '', label: 'News'     },
  podcast: { Icon: Headphones,  accent: 'text-muted-foreground/70', bg: '', label: 'Podcasts' },
}

function SectionBadge({ source }: { source: TickerSource }) {
  const { Icon, accent, label } = SECTION_STYLES[source]
  return (
    <span className="inline-flex items-center gap-1.5 px-3 border-r border-border/20 self-stretch shrink-0">
      <Icon className={cn('size-3 shrink-0', accent)} />
      <span className={cn('text-[10px] font-semibold uppercase tracking-[0.14em] whitespace-nowrap', accent)}>{label}</span>
    </span>
  )
}

function TickerItemChip({ item, onPointerDown }: { item: TickerItem; onPointerDown: () => void }) {
  if (item.type === 'sports') {
    const { league, teams, status, isFinal, isLive } = parseGame(item.title)
    return (
      <span className="inline-flex items-center gap-2 px-4 whitespace-nowrap" onPointerDown={onPointerDown}>
        {league && <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50" title={league}>{league}</span>}
        <span className="text-[12px] font-medium text-foreground/80">{teams}</span>
        {status && (
          <span className={cn("text-[10px]", isLive ? "font-semibold text-success" : isFinal ? "text-muted-foreground/45" : "text-muted-foreground/55")}>
            {isFinal ? "Final" : status}
          </span>
        )}
        <span className="text-border/40">·</span>
      </span>
    )
  }
  if (item.type === 'youtube') {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 whitespace-nowrap cursor-pointer group" onPointerDown={onPointerDown}>
        {/* video thumbnail */}
        <div className="shrink-0 w-[44px] aspect-video overflow-hidden rounded bg-muted">
          <img src={ytImageProxy(`https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`)} alt="" loading="lazy" className="size-full object-cover" />
        </div>
        {/* channel avatar */}
        {item.channelThumb && (
          <div className="shrink-0 size-[16px] overflow-hidden rounded-full bg-muted ring-1 ring-background">
            <img src={ytImageProxy(item.channelThumb)} alt="" loading="lazy" className="size-full object-cover" />
          </div>
        )}
        <span className="text-[12px] font-medium text-foreground/80 group-hover:text-foreground transition-colors max-w-[220px] truncate">{item.title}</span>
        <span className="text-border/40 ml-1">·</span>
      </span>
    )
  }
  if (item.type === 'news') {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 whitespace-nowrap cursor-pointer group" onPointerDown={onPointerDown}>
        {/* article thumbnail */}
        {item.imageUrl && (
          <div className="shrink-0 w-[26px] h-[26px] overflow-hidden rounded bg-muted">
            <img src={proxyImg(item.imageUrl)} alt="" loading="lazy" className="size-full object-cover" />
          </div>
        )}
        {/* favicon */}
        {item.faviconHost ? (
          <div className={cn("shrink-0 overflow-hidden rounded-control bg-muted", item.imageUrl ? "size-[13px]" : "size-[16px]")}>
            <img src={proxyImg(`https://www.google.com/s2/favicons?domain=${item.faviconHost}&sz=32`)} alt="" loading="lazy" className="size-full object-cover" />
          </div>
        ) : !item.imageUrl && (
          <Newspaper className="size-3 text-info/60 shrink-0" />
        )}
        <span className="text-[12px] font-medium text-foreground/80 group-hover:text-foreground transition-colors max-w-[260px] truncate">{item.title}</span>
        <span className="text-border/40 ml-1">·</span>
      </span>
    )
  }
  if (item.type === 'podcast') {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 whitespace-nowrap cursor-pointer group" onPointerDown={onPointerDown}>
        <div className="shrink-0 size-[26px] overflow-hidden rounded bg-muted">
          <img src={item.podCoverUrl} alt="" loading="lazy" className="size-full object-cover" />
        </div>
        <span className="text-[12px] font-medium text-foreground/80 group-hover:text-foreground transition-colors max-w-[240px] truncate">{item.title}</span>
        <span className="text-border/40 ml-1">·</span>
      </span>
    )
  }
  return null
}

function HomeTicker({ config }: { config: TickerConfig }) {
  const ytPb = useYoutubePlayback()
  const podcastPb = usePodcastPlayback()
  const navigate = useNavigate()
  const [readerMode] = useNewsReaderMode()
  const [items, setItems] = useState<TickerItem[]>([])
  const [ready, setReady] = useState(false)

  const innerRef     = useRef<HTMLDivElement>(null)
  const halfRef      = useRef(0)
  const posRef       = useRef(0)
  const modeRef      = useRef<'auto' | 'paused' | 'drag' | 'coast'>('auto')
  const baseSpeed    = useRef(0)
  const velRef       = useRef(0)
  const velBuf       = useRef<{ t: number; rawPos: number }[]>([])
  const dragStartX   = useRef(0)
  const dragStartPos = useRef(0)
  const dragDistRef  = useRef(0)
  const resumeTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafRef       = useRef<number>(0)
  const lastT        = useRef(0)
  const clickedItem  = useRef<TickerItem | null>(null)

  const sourcesKey = config.sources.join(',')

  useEffect(() => {
    if (!config.sources.length) { setReady(true); return }
    const has = (s: TickerSource) => config.sources.includes(s)
    Promise.all([
      has('sports')  ? fetch('/api/sports/today',       { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
      has('youtube') ? fetch('/api/youtube/feed?limit=10', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
      has('news')    ? fetch('/api/news?limit=8',        { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
      has('podcast') ? fetch('/api/podcasts/feed',       { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
    ]).then(([sports, youtube, news, podcast]) => {
      const sportItems: TickerItem[] = ((sports as { games?: GameItem[] } | null)?.games ?? []).map(g => ({ type: 'sports', title: g.title }))
      const ytItems: TickerItem[] = ((youtube as { videos?: (VideoItem & { channelThumb?: string | null })[] } | null)?.videos ?? []).map(v => ({ type: 'youtube', videoId: v.videoId, title: v.title, channelThumb: v.channelThumb, localKind: v.localKind }))
      const newsItems: TickerItem[] = ((news as { items?: NewsItem[] } | null)?.items ?? []).map(n => {
        let faviconHost: string | null = null
        try { if (n.url) faviconHost = new URL(n.url).hostname.replace(/^www\./, '') } catch { /* noop */ }
        return { type: 'news', title: n.title, url: n.url, imageUrl: n.imageUrl, faviconHost }
      })
      type PodFeed = { shows?: Array<{ id: string; name: string }>; episodesByShow?: Record<string, Array<{ id: string; title: string; status: string; generatedAt?: number | string | null; durationSec?: number | null; chapters?: { title: string; startSec: number }[] }>> }
      const podcastItems: TickerItem[] = []
      const podFeed = podcast as PodFeed | null
      if (podFeed?.shows && podFeed?.episodesByShow) {
        podFeed.shows
          .flatMap(show => (podFeed.episodesByShow![show.id] ?? []).filter(e => e.status === 'ready').map(e => ({ ep: e, show })))
          .sort((a, b) => Number(b.ep.generatedAt ?? 0) - Number(a.ep.generatedAt ?? 0))
          .slice(0, 6)
          .forEach(({ ep, show }) => podcastItems.push({ type: 'podcast', episodeId: ep.id, showId: show.id, showName: show.name, title: ep.title, podCoverUrl: `/api/podcasts/shows/${show.id}/cover`, durationSec: ep.durationSec, chapters: ep.chapters ?? [] }))
      }
      // Keep items grouped by source so sections render as contiguous blocks
      const ordered: TickerItem[] = []
      for (const s of config.sources) {
        if (s === 'sports')  ordered.push(...sportItems)
        else if (s === 'youtube') ordered.push(...ytItems)
        else if (s === 'news')    ordered.push(...newsItems)
        else if (s === 'podcast') ordered.push(...podcastItems)
      }
      setItems(ordered)
      setReady(true)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey])

  useLayoutEffect(() => {
    if (!items.length) return
    const w = innerRef.current?.offsetWidth ?? 0
    halfRef.current = w / 2
    if (halfRef.current > 0) {
      const ms = Math.max(items.length * 7, 30) * 1000
      baseSpeed.current = halfRef.current / ms
    }
  }, [items])

  useEffect(() => {
    if (!items.length) return
    lastT.current = 0; modeRef.current = 'auto'; posRef.current = 0
    const wrap = (p: number) => { const h = halfRef.current; return h > 0 ? ((p % h) + h) % h : 0 }
    const tick = (t: number) => {
      if (!lastT.current) lastT.current = t
      const dt = Math.min(t - lastT.current, 50); lastT.current = t
      const inner = innerRef.current
      if (inner && halfRef.current > 0) {
        const mode = modeRef.current
        if (mode === 'auto') {
          posRef.current = wrap(posRef.current + baseSpeed.current * (1 + 0.12 * Math.sin(t * 0.00035)) * dt)
        } else if (mode === 'coast') {
          posRef.current = wrap(posRef.current + velRef.current * dt)
          velRef.current *= Math.pow(FRICTION, dt / 16)
          if (Math.abs(velRef.current) < MIN_MOMENTUM) { velRef.current = 0; modeRef.current = 'paused'; scheduleResume() }
        }
        inner.style.transform = `translateX(${-posRef.current}px)`
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [items])

  useEffect(() => () => { if (resumeTimer.current) clearTimeout(resumeTimer.current) }, [])

  function scheduleResume() {
    if (resumeTimer.current) clearTimeout(resumeTimer.current)
    resumeTimer.current = setTimeout(() => { if (modeRef.current !== 'drag') modeRef.current = 'auto'; resumeTimer.current = null }, RESUME_DELAY_MS)
  }
  function cancelResume() {
    if (resumeTimer.current) { clearTimeout(resumeTimer.current); resumeTimer.current = null }
  }
  function endDrag() {
    if (modeRef.current !== 'drag') return
    const now = Date.now()
    const recent = velBuf.current.filter(v => now - v.t <= 80)
    velRef.current = 0
    if (recent.length >= 2) {
      const a = recent[0]!, b = recent[recent.length - 1]!
      const dt = b.t - a.t
      if (dt > 0) velRef.current = (b.rawPos - a.rawPos) / dt
    }
    velBuf.current = []
    const wasTap = dragDistRef.current < 5
    if (wasTap && clickedItem.current) {
      const item = clickedItem.current
      if (item.type === 'youtube') {
        ytPb.playExpanded({ videoId: item.videoId, title: item.title, author: null, channelThumb: item.channelThumb, localKind: item.localKind })
      } else if (item.type === 'podcast') {
        podcastPb.play({ episodeId: item.episodeId, showId: item.showId, showName: item.showName, title: item.title, coverUrl: item.podCoverUrl, durationSec: item.durationSec ?? undefined, chapters: item.chapters ?? [] })
      } else if (item.type === 'news' && item.url) {
        // Honor the reader-vs-new-tab preference, same as the news cards/widgets.
        // Ticker items carry no feedItems id, so reader mode uses the URL reader.
        if (readerMode === 'reader') navigate(`/news/reader?url=${encodeURIComponent(item.url)}`)
        else window.open(item.url, '_blank', 'noopener,noreferrer')
      }
    }
    clickedItem.current = null; dragDistRef.current = 0
    if (Math.abs(velRef.current) > MIN_MOMENTUM) { modeRef.current = 'coast' } else { modeRef.current = 'paused'; scheduleResume() }
  }

  if (!ready || !items.length) return null

  // Group consecutive items into sections for display
  const sections: TickerSection[] = config.sources
    .map(s => ({ source: s, items: items.filter(i => i.type === s) }))
    .filter(s => s.items.length > 0)
  const doubled = [...sections, ...sections]

  return (
    <div
      className="border-y border-border/25 select-none overflow-hidden cursor-grab active:cursor-grabbing"
      onMouseEnter={() => { cancelResume(); if (modeRef.current === 'auto') modeRef.current = 'paused' }}
      onMouseLeave={() => { if (modeRef.current === 'paused') scheduleResume() }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        cancelResume(); velRef.current = 0; velBuf.current = []
        dragStartX.current = e.clientX; dragStartPos.current = posRef.current
        dragDistRef.current = 0; modeRef.current = 'drag'
        e.preventDefault()
      }}
      onPointerMove={(e) => {
        if (modeRef.current !== 'drag') return
        const rawPos = dragStartPos.current + (dragStartX.current - e.clientX)
        const h = halfRef.current
        posRef.current = h > 0 ? ((rawPos % h) + h) % h : rawPos
        dragDistRef.current = Math.abs(e.clientX - dragStartX.current)
        const now = Date.now()
        velBuf.current.push({ t: now, rawPos })
        velBuf.current = velBuf.current.filter(v => now - v.t <= 100)
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div ref={innerRef} className="flex items-stretch will-change-transform" style={{ width: 'max-content' }}>
        {doubled.map((section, si) => {
          const { bg } = SECTION_STYLES[section.source]
          return (
            <div key={si} className={cn('inline-flex items-center py-1.5 border-r border-border/20', bg)}>
              <SectionBadge source={section.source} />
              {section.items.map((item, ii) => (
                <TickerItemChip key={ii} item={item} onPointerDown={() => { clickedItem.current = item }} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Today's Headlines ─────────────────────────────────────────────────────────

function parseOtdYear(title: string): { year: string; text: string } {
  const m = title.match(/^(\d{1,4})\s*[—–]\s*(.+)$/); // design-ok(em-dash): regex parses dash separators in external titles
  return m ? { year: m[1]!, text: m[2]! } : { year: "", text: title };
}


// ── Canvas widgets ────────────────────────────────────────────────────────────

function WidgetWeather() {
  const { snapshot, status } = useWeatherSnapshot();

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center gap-1.5 text-overline text-muted-foreground/60">
        <span>⛅</span>
        <span>Weather</span>
      </div>
      {status === "loading" && <Spinner className="text-muted-foreground/30" />}
      {status === "no-location" && (
        <p className="text-[12px] text-muted-foreground/60">No location set. Configure in Settings.</p>
      )}
      {status === "ready" && snapshot && (
        <Link to="/weather" className="flex items-center gap-3 group">
          <img src={weatherIconSrc(snapshot.info.icon)} className="size-10 shrink-0" alt="" />
          <div>
            <p className="text-2xl font-semibold tabular-nums leading-none">{snapshot.temp}°</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{snapshot.info.desc}</p>
            <p className="text-[10px] text-muted-foreground/50 mt-0.5 leading-tight">{snapshot.location}</p>
          </div>
        </Link>
      )}
    </div>
  );
}

function WidgetNews({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const limit = displayMode === 'row' ? 6 : 3;
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/news?limit=${limit}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { items?: NewsItem[] } | null) => { setItems(d?.items ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [limit]);

  if (displayMode === 'row') {
    return (
      <RowShelf title="News" to="/news">
        {loading && <Spinner className="text-muted-foreground/30" />}
        {!loading && items.length === 0 && (
          <p className="px-1 text-[13px] text-muted-foreground/60">No news available.</p>
        )}
        {items.length > 0 && (
          <div className="flex gap-4 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {items.map((item, i) => (
              <NewsLink
                key={i}
                item={item}
                className="group shrink-0 w-[200px] flex flex-col gap-2"
              >
                {item.imageUrl ? (
                  <div className="w-full aspect-video overflow-hidden rounded-card bg-muted ring-1 ring-inset ring-border/40 transition-shadow group-hover:shadow-lg group-hover:shadow-black/20">
                    <img
                      src={item.imageUrl} alt="" loading="lazy"
                      className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                    />
                  </div>
                ) : (
                  <div className="w-full aspect-video rounded-card bg-muted/60 ring-1 ring-inset ring-border/40 flex items-center justify-center">
                    <Newspaper className="size-6 text-muted-foreground/20" />
                  </div>
                )}
                <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-foreground/90">{item.title}</p>
                {item.source && (
                  <p className="truncate text-[11px] text-muted-foreground/60">{item.source}</p>
                )}
              </NewsLink>
            ))}
          </div>
        )}
      </RowShelf>
    );
  }

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-muted-foreground/60">
          <Newspaper className="size-3" />
          <span>News</span>
        </div>
        <Link to="/news" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      {loading && <Spinner className="text-muted-foreground/30" />}
      {!loading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No news available.</p>
      )}
      <div className="space-y-0.5 flex-1">
        {items.map((item, i) => (
          <NewsRow key={i} item={item} />
        ))}
      </div>
    </div>
  );
}

function WidgetJokes() {
  const [joke, setJoke] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/jokes", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { joke?: string | null } | null) => { setJoke(d?.joke ?? null); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center gap-1.5 text-overline text-muted-foreground/60">
        <Laugh className="size-3" />
        <span>Joke of the Day</span>
      </div>
      {loading && <Spinner className="text-muted-foreground/30" />}
      {!loading && joke && (
        <p className="text-[13px] italic text-foreground/70 leading-snug flex-1">{joke}</p>
      )}
      {!loading && !joke && (
        <p className="text-[12px] text-muted-foreground/60">No joke today.</p>
      )}
    </div>
  );
}

function WidgetSports() {
  const [games, setGames] = useState<GameItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/sports/today", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { games?: GameItem[] } | null) => { setGames(d?.games ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center gap-1.5 text-overline text-success">
        <Trophy className="size-3" />
        <span>Scores</span>
      </div>
      {loading && <Spinner className="text-muted-foreground/30" />}
      {!loading && games.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No games today.</p>
      )}
      <div className="space-y-1.5 flex-1">
        {games.slice(0, 6).map((g, i) => {
          const { league, teams, status, isFinal, isLive } = parseGame(g.title);
          return (
            <div key={i} className="flex items-center gap-2">
              {league && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/45 shrink-0 w-9" title={league}>
                  {league}
                </span>
              )}
              <span className="text-[11px] font-medium text-foreground/75 flex-1 min-w-0 truncate">{teams}</span>
              {status && (
                <span className={cn(
                  "text-[10px] shrink-0",
                  isLive ? "font-semibold text-success" : isFinal ? "text-muted-foreground/45" : "text-muted-foreground/55",
                )}>
                  {isFinal ? "Final" : status}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WidgetOnThisDay() {
  const [items, setItems] = useState<OtdItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/on-this-day?limit=1", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { events?: OtdItem[] } | null) => { setItems(d?.events?.slice(0, 1) ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const item = items[0];
  const parsed = item ? parseOtdYear(item.title) : null;

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center gap-1.5 text-overline text-warning">
        <CalendarDays className="size-3" />
        <span>On This Day</span>
      </div>
      {loading && <Spinner className="text-muted-foreground/30" />}
      {!loading && parsed && (
        <div className="flex items-start gap-2 flex-1">
          {parsed.year && (
            <span className="text-[14px] font-semibold text-warning tabular-nums leading-tight shrink-0 pt-px">
              {parsed.year}
            </span>
          )}
          <p className="text-[12px] leading-snug text-foreground/70">{parsed.text}</p>
        </div>
      )}
      {!loading && !item && (
        <p className="text-[12px] text-muted-foreground/60">Nothing for today.</p>
      )}
    </div>
  );
}

interface BriefingItem { title: string; detail?: string; url?: string; imageUrl?: string; summary?: string; publishedAt?: number }
interface BriefingPayload {
  date: string;
  weather?: string;
  localNews: BriefingItem[];
  worldNews: BriefingItem[];
  sports: BriefingItem[];
  onThisDay: BriefingItem[];
}

// Briefing items and news cards share a shape; map so we can reuse NewsThumb/NewsLink
// (graceful image→placeholder, reader-mode routing) instead of re-inventing them here.
const briefToNews = (it: BriefingItem): NewsItem => ({
  title: it.title, url: it.url, source: it.detail,
  imageUrl: it.imageUrl, summary: it.summary, publishedAt: it.publishedAt,
});

// Compact secondary row (scores, on-this-day, second story): the item's own photo when it
// has one, otherwise a tinted icon chip. Clickable only when the item links somewhere.
function BriefingRow({ item, icon: Icon, tint, label }: { item: NewsItem; icon: LucideIcon; tint: string; label: string }) {
  const inner = (
    <div className="group flex items-center gap-2.5 py-2.5">
      {item.imageUrl
        ? <img src={proxyImg(item.imageUrl)} alt="" loading="lazy" className="size-9 shrink-0 rounded-control object-cover ring-1 ring-inset ring-border/40" />
        : <div className={cn("grid size-9 shrink-0 place-items-center rounded-control", tint)}><Icon className="size-4" /></div>}
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/50">{label}</p>
        <p className="line-clamp-1 text-[12.5px] font-medium text-foreground/85 transition-colors group-hover:text-brand">{item.title}</p>
      </div>
    </div>
  );
  return item.url ? <NewsLink item={item}>{inner}</NewsLink> : inner;
}

function WidgetBriefing({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const [payload, setPayload] = useState<BriefingPayload | null>(null);
  const [warming, setWarming] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/briefing", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { payload: BriefingPayload | null; warming: boolean } | null) => {
        setPayload(d?.payload ?? null);
        setWarming(d?.warming ?? false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Prefer a story that actually carries a photo for the hero/top tile: hyperlocal items
  // often have no image, while the world feeds always do. Keeps local-first order within
  // each group, so a postered local story still beats a world one.
  const stories = [...(payload?.localNews ?? []), ...(payload?.worldNews ?? [])];
  const ordered = [...stories.filter(s => s.imageUrl), ...stories.filter(s => !s.imageUrl)];
  const topStory = ordered[0];
  const secondStory = ordered[1];
  const topScore = payload?.sports[0];
  const empty = !loading && !payload;

  const header = (
    <div className="flex items-center gap-1.5 text-overline text-warning">
      <Sunrise className="size-3" />
      <span>Morning Briefing</span>
    </div>
  );

  // ── Row mode: full-width shelf of image-led tiles ─────────────────────────────
  if (displayMode === 'row') {
    const tiles: { key: string; label: string; icon: LucideIcon; item: NewsItem }[] = [];
    if (payload?.weather) tiles.push({ key: 'wx', label: 'Weather', icon: CloudSun, item: { title: payload.weather } });
    if (topStory) tiles.push({ key: 'top', label: 'Top Story', icon: Newspaper, item: briefToNews(topStory) });
    if (topScore) tiles.push({ key: 'score', label: 'Scores', icon: Trophy, item: briefToNews(topScore) });

    return (
      <RowShelf title="Morning briefing">
        {(loading || warming) && !payload && <Spinner className="text-muted-foreground/30" />}
        {empty && <p className="px-1 text-[13px] text-muted-foreground/60">No briefing available yet.</p>}
        {tiles.length > 0 && (
          <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tiles.map((t) => {
              const Icon = t.icon;
              const inner = (
                <div className="group h-full w-[230px] shrink-0 overflow-hidden rounded-card bg-card ring-1 ring-inset ring-border/40 transition-shadow hover:shadow-lg hover:shadow-black/20">
                  <div className="relative h-24 w-full overflow-hidden">
                    {t.item.imageUrl
                      ? <img src={proxyImg(t.item.imageUrl)} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
                      : <div className="grid size-full place-items-center bg-muted"><Icon className="size-7 text-muted-foreground/40" /></div>}
                    {t.item.imageUrl && <div className="absolute inset-0 bg-gradient-to-b from-black/45 to-transparent" />}
                    <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                      <Icon className="size-3" />{t.label}
                    </span>
                  </div>
                  <p className="line-clamp-2 p-3 text-[12.5px] font-medium leading-snug text-foreground/85 transition-colors group-hover:text-brand">{t.item.title}</p>
                </div>
              );
              return t.item.url
                ? <NewsLink key={t.key} item={t.item}>{inner}</NewsLink>
                : <div key={t.key}>{inner}</div>;
            })}
          </div>
        )}
      </RowShelf>
    );
  }

  // ── Column mode: a cohesive card with a photo hero + compact rows ─────────────
  if (empty) {
    return (
      <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
        {header}
        <p className="text-[12px] text-muted-foreground/60">No briefing available yet.</p>
      </div>
    );
  }
  if (!payload) {
    return (
      <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
        {header}
        <Spinner className="text-muted-foreground/30" />
      </div>
    );
  }

  const topNews = topStory ? briefToNews(topStory) : null;

  return (
    <div className={cn(cardVariants(), "h-full flex flex-col overflow-hidden p-0")}>
      {topNews ? (
        <NewsLink item={topNews} className="block">
          <div className="group relative h-40 w-full overflow-hidden">
            <NewsThumb item={topNews} className="absolute inset-0 size-full transition-transform duration-500 group-hover:scale-[1.04]" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-black/45" />
            <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/90 drop-shadow">
                <Sunrise className="size-3.5" />Morning Briefing
              </span>
              {payload.weather && (
                <span className="inline-flex max-w-[10rem] items-center gap-1 truncate rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-semibold text-white">
                  <CloudSun className="size-3 shrink-0" /><span className="truncate">{payload.weather}</span>
                </span>
              )}
            </div>
            <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3.5">
              <span className="text-[10px] font-bold uppercase tracking-wide text-white/65">{topNews.source ?? 'Top story'}</span>
              <p className="line-clamp-2 text-[15px] font-bold leading-snug text-white drop-shadow-sm">{topNews.title}</p>
            </div>
          </div>
        </NewsLink>
      ) : (
        <div className="relative flex h-24 flex-col justify-between bg-gradient-to-br from-warning/12 to-transparent p-3.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-warning">
            <Sunrise className="size-3.5" />Morning Briefing
          </span>
          {payload.weather && (
            <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-foreground/80">
              <CloudSun className="size-4 text-info" />{payload.weather}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-1 flex-col divide-y divide-border/40 px-3.5">
        {topScore && <BriefingRow item={briefToNews(topScore)} icon={Trophy} tint="bg-success/15 text-success" label="Scores" />}
        {secondStory && <BriefingRow item={briefToNews(secondStory)} icon={Newspaper} tint="bg-info/15 text-info" label="Also today" />}
      </div>
    </div>
  );
}

// Standard YouTube thumbnail for a video id, routed through the same-origin cache.
const ytThumb = (videoId: string) => ytImageProxy(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);

// Hub items don't carry a YouTube thumbnail URL (ytItemToHub omits it); derive it from
// the id, and proxy everything else through the generic image cache.
function hubThumb(it: HubVideoItem): string | null {
  if (it.source === 'youtube') return ytThumb(it.id);
  return it.thumbnailUrl ? proxyImg(it.thumbnailUrl) : null;
}

/** Full-width editorial shelf for row-mode widgets: the section title sits
 *  directly on the page (no card box, no colored icon eyebrow) with a brand
 *  "See all" link, matching the media-app shelves in Music/Videos/Podcasts.
 *  Column-mode tiles keep their compact card chrome; this is only for the
 *  full-width strips, which is where the boxed "dashboard" look reads wrong. */
function RowShelf({ title, to, children }: { title: string; to?: string; children: React.ReactNode }) {
  return (
    <section className="flex h-full flex-col gap-3">
      <SectionHeader title={title} to={to} className="px-1" />
      {children}
    </section>
  );
}

/** Shared body for every subscriptions widget (unified + per-source). */
function WidgetSubsShell({ label, icon: HeaderIcon, accent, seeAll, items, loading, empty, displayMode, showSourceDot }: {
  label: string;
  icon: LucideIcon;
  accent: string;
  seeAll: string;
  items: HubVideoItem[];
  loading: boolean;
  empty: string;
  displayMode: 'row' | 'column';
  showSourceDot?: boolean;
}) {
  const showCount = displayMode === 'row' ? 8 : 4;
  const vids = items.slice(0, showCount);

  if (displayMode === 'row') {
    return (
      <RowShelf title={label} to={seeAll}>
        {loading && vids.length === 0 && <Spinner className="text-muted-foreground/30" />}
        {!loading && vids.length === 0 && (
          <p className="px-1 text-[13px] text-muted-foreground/60">{empty}</p>
        )}
        {vids.length > 0 && (
          <div className="flex gap-4 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {vids.map((it) => {
              const age = it.publishedText ?? fmtAge(it.publishedAt);
              const thumb = hubThumb(it);
              return (
                <Link key={`${it.source}:${it.id}`} to={HUB_PATHS[it.source].watch(it.id)} className="group shrink-0 w-[200px] flex flex-col gap-2">
                  <div className="relative aspect-video w-full overflow-hidden rounded-card bg-muted ring-1 ring-inset ring-border/40 transition-shadow group-hover:shadow-lg group-hover:shadow-black/20">
                    {thumb && (
                      <img
                        src={thumb} alt="" loading="lazy"
                        className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                      />
                    )}
                    {showSourceDot && (
                      <span className={cn("absolute bottom-1.5 right-1.5 size-2.5 rounded-full ring-2 ring-background", SOURCE_META[it.source].dotClass)} />
                    )}
                  </div>
                  <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-foreground/90">{it.title}</p>
                  <p className="truncate text-[11px] text-muted-foreground/60">
                    {it.creator?.name}{it.creator?.name && age ? " · " : ""}{age}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </RowShelf>
    );
  }

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        {/* design-ok(raw-palette-semantic): per-source brand identity accent */}
        <div className={cn("flex items-center gap-1.5 text-overline", accent)}>
          <HeaderIcon className="size-3" />
          <span>{label}</span>
        </div>
        <Link to={seeAll} className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      {loading && vids.length === 0 && <Spinner className="text-muted-foreground/30" />}
      {!loading && vids.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">{empty}</p>
      )}
      <div className="space-y-2 flex-1">
          {vids.map((it) => {
            const age = it.publishedText ?? fmtAge(it.publishedAt);
            const thumb = hubThumb(it);
            return (
              <Link key={`${it.source}:${it.id}`} to={HUB_PATHS[it.source].watch(it.id)} className="group flex gap-2.5">
                <div className="relative aspect-video w-[88px] shrink-0 overflow-hidden rounded-control bg-muted">
                  {thumb && (
                    <img
                      src={thumb} alt="" loading="lazy"
                      className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                    />
                  )}
                  {showSourceDot && (
                    <span className={cn("absolute bottom-0.5 right-0.5 size-2 rounded-full ring-2 ring-background", SOURCE_META[it.source].dotClass)} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[12px] font-semibold leading-snug text-foreground/85">{it.title}</p>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60">
                    {it.creator?.name}{it.creator?.name && age ? " · " : ""}{age}
                  </p>
                </div>
              </Link>
            );
          })}
      </div>
    </div>
  );
}

/** Unified subscriptions: YouTube feed + the follows feed (TikTok/Vimeo/Reddit) merged
 *  by recency — the widget counterpart of VideosSubscriptionsPage. */
function WidgetSubs({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const feedLimit = displayMode === 'row' ? 10 : 6;
  const { items: ytItems, loading: ytLoading } = useYtFeed(feedLimit);
  const { data: genData, isLoading: genLoading } = useQuery({
    queryKey: ['videos-following-feed'], queryFn: () => getFollowingFeed(), staleTime: 60_000,
  });
  const items = useMemo(
    () => [...ytItems.map(ytItemToHub), ...(genData?.items ?? [])]
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)),
    [ytItems, genData],
  );
  return (
    <WidgetSubsShell
      label="Subscriptions" icon={PlaySquare} accent="text-fuchsia-500"
      seeAll="/videos/subscriptions" items={items} loading={ytLoading || genLoading}
      empty="No recent uploads. Subscribe to channels and creators in Videos."
      displayMode={displayMode} showSourceDot
    />
  );
}

function WidgetYoutubeSubs({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const feedLimit = displayMode === 'row' ? 10 : 6;
  const { items, loading } = useYtFeed(feedLimit);
  const hubItems = useMemo(() => items.map(ytItemToHub), [items]);
  return (
    <WidgetSubsShell
      label="YouTube" icon={Play} accent="text-red-500"
      seeAll="/videos/youtube" items={hubItems} loading={loading}
      empty="No recent uploads. Subscribe to channels in YouTube."
      displayMode={displayMode}
    />
  );
}

/** Lightweight entry point onto the Videos hub's unified category chips (see
 *  VideosHomePage's CategoryBody) — just navigation, no query fan-out on the home canvas. */
function WidgetVideoCategories() {
  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-fuchsia-500">
          <Tag className="size-3" />
          <span>Browse Videos</span>
        </div>
        <Link to="/videos" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      <div className="flex flex-1 flex-wrap content-start gap-1.5">
        {VIDEO_CATEGORIES.map((c) => (
          <Link
            key={c.id}
            to={`/videos?category=${c.id}`}
            className="inline-flex shrink-0 items-center rounded-full bg-foreground/8 px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/12"
          >
            {c.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

const SOURCE_SUBS_ACCENT: Record<string, string> = {
  tiktok: 'text-foreground/70',
  vimeo: 'text-sky-500',
  reddit: 'text-orange-500',
};

/** Per-source subscriptions widget for the follows-based sources. */
function WidgetSourceSubs({ source, displayMode = 'column' }: { source: 'tiktok' | 'vimeo' | 'reddit'; displayMode?: 'row' | 'column' }) {
  const { data, isLoading } = useQuery({
    queryKey: ['videos-following-feed', source], queryFn: () => getFollowingFeed(source), staleTime: 60_000,
  });
  const meta = SOURCE_META[source];
  return (
    <WidgetSubsShell
      label={meta.label} icon={meta.icon} accent={SOURCE_SUBS_ACCENT[source]!}
      seeAll={`/videos/${source}`} items={data?.items ?? []} loading={isLoading}
      empty={`No recent videos. Subscribe to ${source === 'reddit' ? 'subreddits' : 'creators'} in ${meta.label}.`}
      displayMode={displayMode}
    />
  );
}

function WidgetMusic() {
  const radio = useRadio();
  const { data: histData, isLoading: histLoading } = useQuery({ queryKey: ["music-history"], queryFn: () => getHistory(20) });
  const { data: favData } = useQuery({ queryKey: ["music-favorites"], queryFn: () => getFavorites() });
  const { data: stationBuckets } = useQuery({ queryKey: ["music-stations"], queryFn: listStations });

  const recents = (histData?.history ?? []).slice(0, 4);

  const stationById = useMemo(() => {
    const m = new Map<string, Station>();
    if (stationBuckets) {
      for (const s of [...stationBuckets.builtin, ...stationBuckets.mine, ...stationBuckets.shared]) m.set(s.id, s);
    }
    return m;
  }, [stationBuckets]);

  const favStations = useMemo(() => {
    const favs = (favData?.favorites ?? []).filter(f => f.kind === "station");
    return favs.map(f => stationById.get(f.refId)).filter((s): s is Station => !!s).slice(0, 3);
  }, [favData, stationById]);

  const empty = recents.length === 0 && favStations.length === 0;

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2.5")}>
      <div className="flex items-center justify-between">
        {/* design-ok(raw-palette-semantic): music identity orange accent */}
        <div className="flex items-center gap-1.5 text-overline text-orange-400">
          <Music className="size-3" />
          <span>Music</span>
        </div>
        <Link to="/music" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Open →</Link>
      </div>

      {histLoading && empty && <Spinner className="text-muted-foreground/30" />}
      {!histLoading && empty && (
        <p className="text-[12px] text-muted-foreground/60">Start a station to see it here.</p>
      )}

      {favStations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {favStations.map(s => (
            <button
              key={s.id}
              onClick={() => radio.start(stationToDj(s))}
              className={cn(
                // design-ok(raw-palette-semantic): music identity orange accent
                "flex items-center gap-1 rounded-full border border-orange-400/25 bg-orange-400/10 px-2.5 py-1 text-[11px] font-semibold text-orange-300/90 transition-colors hover:bg-orange-400/20",
              )}
            >
              <Heart className="size-2.5 fill-current" />
              <span className="max-w-[120px] truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}

      {recents.length > 0 && (
        <div className="flex-1 space-y-1.5">
          {favStations.length > 0 && (
            <p className="text-overline text-muted-foreground/40">Recently played</p>
          )}
          {recents.map(t => (
            <button
              key={t.id}
              onClick={() => radio.playTrack({ videoId: t.videoId, title: t.title, author: t.artist ?? undefined, thumbnail: ytThumb(t.videoId) })}
              className="group flex w-full items-center gap-2.5 text-left"
            >
              <img src={ytThumb(t.videoId)} alt="" loading="lazy" className="size-9 shrink-0 rounded-control object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold leading-snug text-foreground/85">{t.title}</p>
                {t.artist && <p className="truncate text-[10px] text-muted-foreground/60">{t.artist}</p>}
              </div>
              {/* design-ok(raw-palette-semantic): music identity orange accent */}
              <Play className="size-3.5 shrink-0 text-orange-400 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetBookmarksRecent({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const limit = displayMode === 'row' ? 10 : 6;
  const show  = displayMode === 'row' ? 8 : 4;
  const [items, setItems] = useState<BookmarkItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/bookmarks?limit=${limit}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { items?: BookmarkItem[] } | null) => { setItems((d?.items ?? []).filter(b => !b.isHidden).slice(0, show)); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [limit, show]);

  const fmtDomain = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-brand">
          <Bookmark className="size-3" />
          <span>Bookmarks</span>
        </div>
        <Link to="/bookmarks" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      {loading && items.length === 0 && <Spinner className="text-muted-foreground/30" />}
      {!loading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No bookmarks yet. Save an article to see it here.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {items.map(b => (
            <Link key={b.id} to={`/bookmarks/${b.id}`} className="group shrink-0 w-[160px] flex flex-col gap-1.5">
              <div className="relative aspect-video w-full overflow-hidden rounded-card bg-muted flex items-center justify-center">
                {b.ogImagePath
                  ? <img src={`/api/bookmarks/${b.id}/archive/${b.ogImagePath}`} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
                  : b.faviconUrl
                    ? <img src={b.faviconUrl} alt="" loading="lazy" className="size-8 object-contain" />
                    : <Bookmark className="size-6 text-muted-foreground/30" />
                }
              </div>
              <p className="line-clamp-2 text-[11px] font-semibold leading-snug text-foreground/85">{b.title}</p>
              <p className="truncate text-[10px] text-muted-foreground/55">{b.siteName ?? fmtDomain(b.url)}</p>
            </Link>
          ))}
        </div>
      ) : (
        <div className="space-y-2 flex-1">
          {items.map(b => (
            <Link key={b.id} to={`/bookmarks/${b.id}`} className="group flex gap-2.5 items-start">
              <div className="size-9 shrink-0 rounded-control bg-muted overflow-hidden flex items-center justify-center">
                {b.faviconUrl
                  ? <img src={b.faviconUrl} alt="" loading="lazy" className="size-5 object-contain" />
                  : <Bookmark className="size-4 text-muted-foreground/30" />
                }
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[12px] font-semibold leading-snug text-foreground/85">{b.title}</p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60">{b.siteName ?? fmtDomain(b.url)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// Reading Queue — offline articles saved but not finished (unread first as "next up",
// then in-progress). Reuses the bookmarks list API's status/type filters.
function WidgetBookmarksQueue({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const show = displayMode === 'row' ? 8 : 5;
  const [items, setItems] = useState<BookmarkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/bookmarks?status=reading&type=offline', { credentials: 'include' }).then(r => r.ok ? r.json() : null),
      fetch('/api/bookmarks?status=unread&type=offline', { credentials: 'include' }).then(r => r.ok ? r.json() : null),
    ])
      .then(([reading, unread]: ({ items?: BookmarkItem[] } | null)[]) => {
        const merged = [...(reading?.items ?? []), ...(unread?.items ?? [])];
        setTotal(merged.length);
        setItems(merged.slice(0, show));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [show]);

  const fmtDomain = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-brand">
          <BookOpen className="size-3" />
          <span>Reading Queue{total > 0 && <span className="ml-1 text-muted-foreground/50">· {total}</span>}</span>
        </div>
        <Link to="/bookmarks" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      {loading && items.length === 0 && <Spinner className="text-muted-foreground/30" />}
      {!loading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">Reading list is clear. Saved articles land here until you've read them.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {items.map(b => (
            <Link key={b.id} to={`/bookmarks/read/${b.id}`} className="group shrink-0 w-[160px] flex flex-col gap-1.5">
              <div className="relative aspect-video w-full overflow-hidden rounded-card bg-muted flex items-center justify-center">
                {b.ogImagePath
                  ? <img src={`/api/bookmarks/${b.id}/archive/${b.ogImagePath}`} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
                  : b.faviconUrl
                    ? <img src={b.faviconUrl} alt="" loading="lazy" className="size-8 object-contain" />
                    : <BookOpen className="size-6 text-muted-foreground/30" />
                }
                {b.readingMins > 0 && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-semibold text-white">{b.readingMins} min</span>
                )}
              </div>
              <p className="line-clamp-2 text-[11px] font-semibold leading-snug text-foreground/85">{b.title}</p>
              <p className="truncate text-[10px] text-muted-foreground/55">
                {b.status === 'reading' ? 'In progress · ' : ''}{b.siteName ?? fmtDomain(b.url)}
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <div className="space-y-2 flex-1">
          {items.map(b => (
            <Link key={b.id} to={`/bookmarks/read/${b.id}`} className="group flex gap-2.5 items-start">
              <div className="size-9 shrink-0 rounded-control bg-muted overflow-hidden flex items-center justify-center">
                {b.faviconUrl
                  ? <img src={b.faviconUrl} alt="" loading="lazy" className="size-5 object-contain" />
                  : <BookOpen className="size-4 text-muted-foreground/30" />
                }
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[12px] font-semibold leading-snug text-foreground/85">{b.title}</p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60">
                  {b.status === 'reading' ? 'In progress' : `${b.readingMins || '?'} min`} · {b.siteName ?? fmtDomain(b.url)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetPodcastsRecent({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const { data, isLoading } = usePodcastFeed();
  const podcast = usePodcastPlayback();
  const show   = displayMode === 'row' ? 8 : 4;
  const items  = newEpisodes(data?.all ?? []).slice(0, show);

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-brand">
          <Headphones className="size-3" />
          <span>New Episodes</span>
        </div>
        <Link to="/podcasts" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      {isLoading && items.length === 0 && <Spinner className="text-muted-foreground/30" />}
      {!isLoading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No episodes yet. Generate one from a podcast show.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {items.map(({ episode, show: s }) => (
            <button key={episode.id} onClick={() => podcast.play({ episodeId: episode.id, showId: s.id, showName: s.name, title: episode.title, durationSec: episode.durationSec ?? undefined, coverUrl: coverUrl(s.id) })} className="group shrink-0 w-[140px] flex flex-col gap-1.5 text-left">
              <div className="relative aspect-square w-full overflow-hidden rounded-card bg-muted">
                <img src={coverUrl(s.id)} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
              </div>
              <p className="line-clamp-2 text-[11px] font-semibold leading-snug text-foreground/85">{episode.title}</p>
              <p className="truncate text-[10px] text-muted-foreground/55">{s.name}</p>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-2 flex-1">
          {items.map(({ episode, show: s }) => (
            <button key={episode.id} onClick={() => podcast.play({ episodeId: episode.id, showId: s.id, showName: s.name, title: episode.title, durationSec: episode.durationSec ?? undefined, coverUrl: coverUrl(s.id) })} className="group flex gap-2.5 items-center text-left w-full">
              <img src={coverUrl(s.id)} alt="" loading="lazy" className="size-9 shrink-0 rounded-control object-cover" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[12px] font-semibold leading-snug text-foreground/85">{episode.title}</p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60">{s.name}</p>
              </div>
              <Play className="size-3.5 shrink-0 text-brand opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetPodcastsContinue() {
  const { data, isLoading } = usePodcastFeed();
  const podcast = usePodcastPlayback();
  const items = continueListening(data?.all ?? []).slice(0, 4);

  const fmtProgress = (pos: number, dur: number | null | undefined) => {
    if (!dur) return null;
    return Math.round((pos / dur) * 100);
  };

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-brand">
          <CirclePlay className="size-3" />
          <span>Continue Listening</span>
        </div>
        <Link to="/podcasts" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Library →</Link>
      </div>
      {isLoading && items.length === 0 && <Spinner className="text-muted-foreground/30" />}
      {!isLoading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">Start listening to an episode to resume it here.</p>
      )}
      <div className="space-y-2 flex-1">
        {items.map(({ episode, show: s }) => {
          const pct = fmtProgress(episode.watchState?.positionSec ?? 0, episode.durationSec);
          return (
            <button key={episode.id} onClick={() => podcast.play({ episodeId: episode.id, showId: s.id, showName: s.name, title: episode.title, durationSec: episode.durationSec ?? undefined, coverUrl: coverUrl(s.id) }, episode.watchState?.positionSec)} className="group flex gap-2.5 items-center text-left w-full">
              <img src={coverUrl(s.id)} alt="" loading="lazy" className="size-9 shrink-0 rounded-control object-cover" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="line-clamp-1 text-[12px] font-semibold leading-snug text-foreground/85">{episode.title}</p>
                <p className="truncate text-[10px] text-muted-foreground/60">{s.name}</p>
                {pct != null && (
                  <div className="h-0.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              <Play className="size-3.5 shrink-0 text-brand opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WidgetVideosContinue() {
  const { data: yt = [], isLoading: ytLoading } = useQuery({ queryKey: ["yt-history"], queryFn: getYtHistory });
  const { data: hub, isLoading: hubLoading } = useQuery({ queryKey: ["videos-history"], queryFn: getHubHistory });

  // Same merge as the Videos hub's Continue-watching shelf: every source, freshest first.
  const items = useMemo(() => {
    const fromYt = yt
      .filter((h) => !h.completed && h.positionSec > 5 && h.title.trim())
      .map((h) => ({
        key: `youtube:${h.videoId}`, to: `/videos/youtube/watch/${h.videoId}`,
        title: h.title, creator: h.author, thumb: thumbUrl(h.videoId),
        positionSec: h.positionSec, durationSec: h.durationSec, updatedAt: h.updatedAt,
      }));
    const fromHub = (hub?.history ?? [])
      .filter((h) => !h.completed && h.positionSec > 5 && h.title.trim())
      .map((h) => ({
        key: `${h.source}:${h.videoId}`, to: `/videos/${h.source}/watch/${h.videoId}`,
        title: h.title, creator: h.creatorName, thumb: h.thumbnailUrl ? proxyImg(h.thumbnailUrl) : null,
        positionSec: h.positionSec, durationSec: h.durationSec, updatedAt: h.updatedAt,
      }));
    return [...fromYt, ...fromHub].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
  }, [yt, hub]);

  const loading = (ytLoading || hubLoading) && items.length === 0;
  const pct = (pos: number, dur: number | null | undefined) => (dur ? Math.min(100, Math.round((pos / dur) * 100)) : null);

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-brand">
          <Play className="size-3" />
          <span>Continue Watching</span>
        </div>
        <Link to="/videos" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Videos →</Link>
      </div>
      {loading && <Spinner className="text-muted-foreground/30" />}
      {!loading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">Start a video anywhere and resume it here.</p>
      )}
      <div className="space-y-2 flex-1">
        {items.map((it) => {
          const p = pct(it.positionSec, it.durationSec);
          return (
            <Link key={it.key} to={it.to} className="group flex gap-2.5 items-center text-left w-full">
              {it.thumb ? (
                <img src={it.thumb} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-control object-cover bg-muted" />
              ) : (
                <div className="h-9 w-16 shrink-0 rounded-control bg-muted" />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <p className="line-clamp-1 text-[12px] font-semibold leading-snug text-foreground/85">{it.title}</p>
                {it.creator && <p className="truncate text-[10px] text-muted-foreground/60">{it.creator}</p>}
                {p != null && (
                  <div className="h-0.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${p}%` }} />
                  </div>
                )}
              </div>
              <Play className="size-3.5 shrink-0 text-brand opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

interface WatchlistItem {
  id: string; mediaType: 'show' | 'movie'; refId: string;
  title: string; posterUrl?: string | null; subtitle?: string | null;
  status: 'want' | 'watching' | 'completed' | 'dropped';
}

function WidgetWatchlist({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const show  = displayMode === 'row' ? 8 : 4;
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/library/watchlist', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { items?: WatchlistItem[] } | null) => {
        setItems((d?.items ?? []).filter(i => i.status !== 'completed' && i.status !== 'dropped').slice(0, show));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [show]);

  const itemHref = (item: WatchlistItem) =>
    item.mediaType === 'show' ? `/shows/${item.refId}` : `/movies?title=${encodeURIComponent(item.title)}`;

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-brand">
          <Tv className="size-3" />
          <span>Watchlist</span>
        </div>
        <Link to="/shows" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Browse →</Link>
      </div>
      {loading && items.length === 0 && <Spinner className="text-muted-foreground/30" />}
      {!loading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No watchlist yet. Add shows or movies to track them.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {items.map(item => (
            <Link key={item.id} to={itemHref(item)} className="group shrink-0 w-[100px] flex flex-col gap-1.5">
              <div className="relative w-full overflow-hidden rounded-card bg-muted" style={{ aspectRatio: '2/3' }}>
                {item.posterUrl
                  ? <img src={item.posterUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
                  : <Tv className="absolute inset-0 m-auto size-6 text-muted-foreground/25" />
                }
                <span className="absolute top-1 right-1 rounded-full bg-black/60 px-1 py-px text-[9px] font-bold uppercase text-white/80">
                  {item.mediaType === 'show' ? 'TV' : 'Film'}
                </span>
              </div>
              <p className="line-clamp-2 text-[11px] font-semibold leading-snug text-foreground/85">{item.title}</p>
              {item.subtitle && <p className="truncate text-[10px] text-muted-foreground/55">{item.subtitle}</p>}
            </Link>
          ))}
        </div>
      ) : (
        <div className="space-y-2 flex-1">
          {items.map(item => (
            <Link key={item.id} to={itemHref(item)} className="group flex gap-2.5 items-center">
              <div className="relative w-[36px] shrink-0 overflow-hidden rounded-control bg-muted flex items-center justify-center" style={{ aspectRatio: '2/3' }}>
                {item.posterUrl
                  ? <img src={item.posterUrl} alt="" loading="lazy" className="size-full object-cover" />
                  : <Tv className="size-4 text-muted-foreground/30" />
                }
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-[12px] font-semibold leading-snug text-foreground/85">{item.title}</p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60">{item.subtitle ?? (item.mediaType === 'show' ? 'TV Show' : 'Movie')}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetPodcastsShows({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const { data, isLoading } = usePodcastFeed();
  const shows = (data?.shows ?? []).slice(0, displayMode === 'row' ? 8 : 4);

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-brand">
          <ListVideo className="size-3" />
          <span>My Shows</span>
        </div>
        <Link to="/podcasts/library" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Library →</Link>
      </div>
      {isLoading && shows.length === 0 && <Spinner className="text-muted-foreground/30" />}
      {!isLoading && shows.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No shows yet. Create one in the Podcasts app.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {shows.map(s => (
            <Link key={s.id} to={`/podcasts/show/${s.id}`} className="group shrink-0 w-[120px] flex flex-col gap-1.5">
              <div className="relative aspect-square w-full overflow-hidden rounded-card bg-muted">
                <img src={coverUrl(s.id)} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
              </div>
              <p className="line-clamp-2 text-[11px] font-semibold leading-snug text-foreground/85">{s.name}</p>
              <p className="truncate text-[10px] text-muted-foreground/55 capitalize">{s.style}</p>
            </Link>
          ))}
        </div>
      ) : (
        <div className="space-y-2 flex-1">
          {shows.map(s => (
            <Link key={s.id} to={`/podcasts/show/${s.id}`} className="group flex gap-2.5 items-center">
              <img src={coverUrl(s.id)} alt="" loading="lazy" className="size-9 shrink-0 rounded-control object-cover" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-[12px] font-semibold leading-snug text-foreground/85">{s.name}</p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60 capitalize">{s.style}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetUnavailable() {
  return (
    <div className={cn(cardVariants({ variant: "dashed" }), "p-4 h-full flex flex-col items-center justify-center gap-1.5 text-center")}>
      <LayoutGrid className="size-5 text-muted-foreground/25" />
      <p className="text-[11px] text-muted-foreground/40">Widget unavailable</p>
    </div>
  );
}

const SPEED_PATH_LABEL: Record<SpeedMode, string> = {
  internet: 'App → Internet',
  server: 'App → Server',
  'server-internet': 'Server → Internet',
};

function WidgetSpeedTest({ mode }: { mode: SpeedMode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [thresholds, setThresholds] = useState<SpeedThresholds>(DEFAULT_THRESHOLDS);
  const [result, setResult] = useState<SpeedResult | null>(null);
  const [phase, setPhase] = useState<SpeedPhase>('idle');
  const [live, setLive] = useState(0);
  const running = phase !== 'idle' && phase !== 'done';
  const runningRef = useRef(false);
  const hasUpload = mode !== 'server-internet';

  useEffect(() => {
    void loadThresholds().then(setThresholds);
    if (!user?.id) return;
    void loadLastResults(user.id).then(r => { setResult(r[mode]); });
  }, [user?.id, mode]);

  const run = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (runningRef.current) return;
    runningRef.current = true;
    setResult(null); setLive(0);
    try {
      const res = await runSpeedTest(mode, (p) => {
        setPhase(p.phase);
        if (p.phase === 'download' || p.phase === 'upload' || p.phase === 'done') setLive(p.mbps);
      });
      setResult(res); setPhase('done');
      if (user?.id) void saveLastResult(user.id, res);
    } catch {
      setPhase('idle');
    } finally {
      runningRef.current = false;
    }
  }, [mode, user?.id]);

  const rating = result ? rateSpeed(result.downloadMbps, thresholds) : null;

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-info">
          <Gauge className="size-3" />
          <span>{SPEED_PATH_LABEL[mode]}</span>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="text-info/70 hover:text-info transition-colors disabled:opacity-50"
          title="Run speed test"
        >
          {running
            ? <Spinner size="sm" className="text-current" />
            : <RotateCw className="size-3.5" />}
        </button>
      </div>

      {running ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-1">
          <span className="text-3xl font-semibold tabular-nums text-info">{fmtMbps(live)}</span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/55">
            {phase === 'upload' ? 'Upload Mbps' : phase === 'ping' ? 'Pinging…' : 'Download Mbps'}
          </span>
        </div>
      ) : result ? (
        <button onClick={() => navigate('/speed-test')} className="flex-1 flex flex-col justify-center gap-2 text-left">
          <div className="flex items-baseline gap-1.5">
            <span className={cn('text-3xl font-semibold tabular-nums', rating && RATING_META[rating].text)}>
              {fmtMbps(result.downloadMbps)}
            </span>
            <span className="text-[11px] font-semibold text-muted-foreground/55">Mbps down</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
            {hasUpload && (
              <span className="flex items-center gap-1"><Upload className="size-3" />{fmtMbps(result.uploadMbps)}</span>
            )}
            <span className="flex items-center gap-1"><Activity className="size-3" />{fmtMs(result.pingMs)} ms</span>
          </div>
        </button>
      ) : (
        <button onClick={run} className="flex-1 flex flex-col items-center justify-center gap-1.5 text-muted-foreground/60 hover:text-foreground/80 transition-colors">
          <Gauge className="size-7" />
          <span className="text-[12px] font-medium">Run a speed test</span>
        </button>
      )}
    </div>
  );
}

// ── WidgetStatus ─────────────────────────────────────────────────────────────
// design-ok(hex-in-tsx): status preset color data
const STATUS_WIDGET_PRESETS = [
  { state: 'available', label: 'Available', color: '#22c55e', icon: '🟢' },
  { state: 'busy',      label: 'Busy',      color: '#ef4444', icon: '🔴' },
  { state: 'focusing',  label: 'Focusing',  color: '#3b82f6', icon: '🔵' },
  { state: 'dnd',       label: 'DND',       color: '#7c3aed', icon: '🟣' },
  { state: 'brb',       label: 'BRB',       color: '#eab308', icon: '🟡' },
] as const

function WidgetStatus() {
  const { user } = useAuth()
  const [current, setCurrent] = useState<{ state: string; label: string; color: string; timerEndsAt: number | null } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/pod/presence', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { status?: { state: string; label: string; color: string; timerEndsAt: number | null } | null } | null) => {
        setCurrent(d?.status ?? null)
      })
      .catch(() => { /* ignore */ })
  }, [user?.id])

  const setStatus = async (state: string | null) => {
    if (busy) return
    setBusy(true)
    try {
      if (!state || current?.state === state) {
        await fetch('/api/pod/status', { method: 'DELETE', credentials: 'include' })
        setCurrent(null)
      } else {
        const r = await fetch('/api/pod/status', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state }),
        })
        const d = await r.json() as { status?: { state: string; label: string; color: string; timerEndsAt: number | null } }
        if (d.status) setCurrent(d.status)
      }
    } catch { /* ignore */ } finally { setBusy(false) }
  }

  const currentPreset = STATUS_WIDGET_PRESETS.find(p => p.state === current?.state)

  return (
    <div className="flex flex-col gap-3 p-4 h-full">
      {/* Current status pill */}
      <div
        // design-ok(hex-in-tsx): status preset color data
        className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors"
        style={{ backgroundColor: current?.color ?? '#6b7280' }}
      >
        <span>{currentPreset?.icon ?? '⚪'}</span>
        <span>{current?.label ?? 'No status'}</span>
        {current?.timerEndsAt && (
          <span className="ml-auto font-mono text-xs opacity-80">
            {Math.max(0, Math.round((current.timerEndsAt - Date.now()) / 60000))}m
          </span>
        )}
      </div>
      {/* Preset buttons */}
      <div className="grid grid-cols-3 gap-1.5 flex-1">
        {STATUS_WIDGET_PRESETS.map((p) => (
          <button
            key={p.state}
            disabled={busy}
            onClick={() => setStatus(p.state)}
            className={`flex flex-col items-center justify-center gap-1 rounded-card border p-2 text-center text-xs font-medium transition-colors disabled:opacity-60 ${
              current?.state === p.state
                ? 'text-white shadow-sm border-transparent'
                : 'border-border/50 text-muted-foreground hover:bg-muted/40'
            }`}
            style={current?.state === p.state ? { backgroundColor: p.color } : undefined}
          >
            <span className="text-lg">{p.icon}</span>
            <span>{p.label}</span>
          </button>
        ))}
        <button
          disabled={busy}
          onClick={() => setStatus(null)}
          className="flex flex-col items-center justify-center gap-1 rounded-card border border-border/50 p-2 text-center text-xs font-medium text-muted-foreground hover:bg-muted/40 transition-colors disabled:opacity-60"
        >
          <span className="text-lg">✕</span>
          <span>Clear</span>
        </button>
      </div>
    </div>
  )
}

// ── WidgetHASummary ───────────────────────────────────────────────────────────

interface HASummary {
  configured: boolean
  counts?: { lightsOn: number; devicesOn: number; mediaPlaying: number; securityOpen: number }
  mediaPlaying?: { entity_id: string; name: string; title: string | null; artist: string | null }[]
  securityOpen?: { entity_id: string; name: string; state: string; kind: string }[]
  hasEntities?: boolean
}

// Compact error state shared by the HA widgets — no forever-spinner when HA is down.
function WidgetHAUnavailable() {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 h-full p-4 text-muted-foreground/50">
      <Home className="size-7" />
      <span className="text-[12px] font-medium">Home Assistant unavailable</span>
    </div>
  )
}

// While the last fetch errored, back the poll off to 2 min instead of hammering
// a down Home Assistant every 30s.
const haRefetchInterval = (query: { state: { error: unknown } }) =>
  query.state.error ? 120_000 : 30_000

function WidgetHASummary() {
  const navigate = useNavigate()
  const { data, isError } = useQuery({
    queryKey: ['ha-summary'],
    queryFn: async (): Promise<HASummary> => {
      const r = await fetch('/api/home-assistant/summary', { credentials: 'include' })
      if (!r.ok) throw new Error('summary failed')
      return (await r.json()) as HASummary
    },
    refetchInterval: haRefetchInterval,
  })

  if (!data) {
    if (isError) return <WidgetHAUnavailable />
    return <div className="flex items-center justify-center h-full p-4"><Spinner size="lg" className="text-muted-foreground/50" /></div>
  }
  if (!data.configured) {
    return (
      <button onClick={() => navigate('/home-assistant')} className="flex flex-col items-center justify-center gap-1.5 h-full p-4 text-muted-foreground/60 hover:text-foreground/80 transition-colors">
        <Home className="size-7" />
        <span className="text-[12px] font-medium">Connect Home Assistant</span>
      </button>
    )
  }
  if (data.hasEntities === false) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 h-full p-4 text-muted-foreground/60">
        <Home className="size-7" />
        <span className="text-[12px] font-medium">No devices available</span>
      </div>
    )
  }

  const c = data.counts ?? { lightsOn: 0, devicesOn: 0, mediaPlaying: 0, securityOpen: 0 }
  const media = data.mediaPlaying?.[0]
  const openItems = data.securityOpen ?? []
  const secure = openItems.length === 0

  return (
    <div className="flex flex-col gap-2.5 p-4 h-full">
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => navigate('/home-assistant')} className="flex items-center gap-2.5 rounded-card bg-warning/10 border border-warning/20 px-3 py-2.5 text-left hover:bg-warning/15 transition-colors">
          <Lightbulb className="size-4.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="text-lg font-semibold leading-none tabular-nums">{c.lightsOn}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">light{c.lightsOn !== 1 ? 's' : ''} on</p>
          </div>
        </button>
        <button onClick={() => navigate('/home-assistant')} className="flex items-center gap-2.5 rounded-card bg-info/10 border border-info/20 px-3 py-2.5 text-left hover:bg-info/15 transition-colors">
          <Power className="size-4.5 shrink-0 text-info" />
          <div className="min-w-0">
            <p className="text-lg font-semibold leading-none tabular-nums">{c.devicesOn}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">device{c.devicesOn !== 1 ? 's' : ''} on</p>
          </div>
        </button>
      </div>
      <button onClick={() => navigate('/home-assistant')} className="flex items-center gap-2.5 rounded-card bg-brand/10 border border-brand/20 px-3 py-2 text-left hover:bg-brand/15 transition-colors">
        <Volume2 className="size-4 shrink-0 text-brand" />
        <p className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
          {media
            ? <>{media.name}: <span className="font-semibold">{media.title ?? 'playing'}</span>{c.mediaPlaying > 1 ? ` +${c.mediaPlaying - 1}` : ''}</>
            : <span className="text-muted-foreground/60">Nothing playing</span>}
        </p>
      </button>
      <button
        onClick={() => navigate('/home-assistant')}
        className={cn(
          'flex items-center gap-2.5 rounded-card border px-3 py-2 text-left transition-colors',
          secure ? 'bg-success/10 border-success/20 hover:bg-success/15' : 'bg-destructive/10 border-destructive/25 hover:bg-destructive/15',
        )}
      >
        {secure
          ? <ShieldCheck className="size-4 shrink-0 text-success" />
          : <LockOpen className="size-4 shrink-0 text-destructive" />}
        <p className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
          {secure
            ? <span className="text-success/90 font-medium">All secure</span>
            : <span className="font-semibold text-destructive">{openItems.map(o => o.name).join(', ')} {openItems.length === 1 ? openItems[0]!.state : 'open'}</span>}
        </p>
      </button>
    </div>
  )
}

// ── WidgetHAFavorites ─────────────────────────────────────────────────────────

// Optimistic state for simple state-changing actions (mirrors HomeAssistantPage).
function haOptimisticState(action: string): string | null {
  switch (action) {
    case 'turn_on': return 'on'
    case 'turn_off': return 'off'
    case 'lock': return 'locked'
    case 'unlock': return 'unlocked'
    case 'open': return 'open'
    case 'close': return 'closed'
    default: return null
  }
}

// Favorites render with the EXACT same mechanism as the Home Assistant page:
// the shared DeviceCard (HAIcon-accurate icons, friendly_name, per-domain look
// + control strips). This keeps names, icons and styling identical everywhere.
function WidgetHAFavorites() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [errorId, setErrorId] = useState<string | null>(null)

  const { data, isError } = useQuery({
    queryKey: ['home-assistant-entities'],
    queryFn: async () => {
      const r = await fetch('/api/home-assistant/entities', { credentials: 'include' })
      if (!r.ok) throw new Error('fetch failed')
      return (await r.json()) as { configured: boolean; entities?: HAEntity[] }
    },
    refetchInterval: haRefetchInterval,
  })

  // Favorite ids come from the shared user-preferences query (one fetch app-wide).
  const { data: prefs, isError: prefsError } = useUserPreferences()
  const favoriteIds = useMemo<string[] | null>(() => {
    if (prefs === undefined) return prefsError ? [] : null
    const fav = prefs['ha.favorites']
    return Array.isArray(fav) ? fav.filter((v): v is string => typeof v === 'string') : []
  }, [prefs, prefsError])

  // Optimistic flow: on success, write the new state for just this entity into the
  // shared cache (no full-list refetch per toggle) and let an invalidate + the 30s
  // poll settle the real state behind it.
  async function callEntity(entity: HAEntity, action: string, value?: number | string) {
    const optimistic = haOptimisticState(action)
    const prevState = entity.state
    if (optimistic) setOverrides(prev => ({ ...prev, [entity.entity_id]: optimistic }))
    setErrorId(null)
    try {
      const r = await fetch('/api/home-assistant/entity', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: entity.entity_id, action, ...(value !== undefined ? { value } : {}) }),
      })
      const res = (await r.json()) as { ok: boolean }
      if (!res.ok) {
        if (optimistic) setOverrides(prev => ({ ...prev, [entity.entity_id]: prevState }))
        setErrorId(entity.entity_id)
      } else {
        if (optimistic) {
          queryClient.setQueryData<{ configured: boolean; entities?: HAEntity[] }>(
            ['home-assistant-entities'],
            (old) => old?.entities
              ? { ...old, entities: old.entities.map(en => en.entity_id === entity.entity_id ? { ...en, state: optimistic } : en) }
              : old,
          )
          // Mark stale; the 30s poll (or the HA page, if open) picks up the real state.
          void queryClient.invalidateQueries({ queryKey: ['home-assistant-entities'], refetchType: 'none' })
        } else {
          // No known optimistic state (e.g. brightness/level changes) — background refetch.
          void queryClient.invalidateQueries({ queryKey: ['home-assistant-entities'] })
        }
        setOverrides(prev => { const n = { ...prev }; delete n[entity.entity_id]; return n })
      }
    } catch {
      if (optimistic) setOverrides(prev => ({ ...prev, [entity.entity_id]: prevState }))
      setErrorId(entity.entity_id)
    }
  }

  const onToggle = (e: HAEntity, v: boolean) => { void callEntity(e, v ? 'turn_on' : 'turn_off') }
  const onAction: CardAction = (e, action, value) => { void callEntity(e, action, value) }
  const onOpen = () => navigate('/home-assistant')

  const favorites = (favoriteIds ?? [])
    .map(id => (data?.entities ?? []).find(e => e.entity_id === id))
    .filter((e): e is HAEntity => !!e)
    .map(e => (e.entity_id in overrides ? { ...e, state: overrides[e.entity_id]! } : e))
    .slice(0, 6)

  if (!data || favoriteIds === null) {
    if (isError) return <WidgetHAUnavailable />
    return <div className="flex items-center justify-center h-full p-4"><Spinner size="lg" className="text-muted-foreground/50" /></div>
  }
  if (!data.configured || favorites.length === 0) {
    return (
      <button onClick={() => navigate('/home-assistant')} className="flex flex-col items-center justify-center gap-1.5 h-full p-4 text-muted-foreground/60 hover:text-foreground/80 transition-colors">
        <Star className="size-7" />
        <span className="text-[12px] font-medium text-center">Star devices in the Home app to see them here</span>
      </button>
    )
  }

  return (
    <div className="grid gap-2 p-4 h-full content-start" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {favorites.map(e => (
        <DeviceCard key={e.entity_id} entity={e} onToggle={onToggle} onOpen={onOpen} onAction={onAction} errorId={errorId} favorite showArea />
      ))}
    </div>
  )
}

// ── Widget renderers ──────────────────────────────────────────────────────────
// Keyed by canonical widget id (see lib/homeWidgets). The catalog there is the
// source of truth for which widgets exist; this map just wires ids to views.

interface PriceDropProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  lastChangedAt: number | null;
  best: { retailerLabel: string; priceCents: number | null; effective: { effectiveCents: number } | null } | null;
}

function WidgetPriceDrops({ displayMode }: { displayMode: 'row' | 'column' }) {
  const { data, isLoading } = useQuery({
    queryKey: ['price-drops-widget'],
    queryFn: async () => {
      const res = await fetch('/api/shopping/products?sort=recentDrop&limit=8', { credentials: 'include' });
      if (!res.ok) return { products: [] as PriceDropProduct[] };
      return res.json() as Promise<{ products: PriceDropProduct[] }>;
    },
  });
  const products = data?.products ?? [];
  const price = (p: PriceDropProduct) =>
    p.best ? `$${(((p.best.effective?.effectiveCents ?? p.best.priceCents) ?? 0) / 100).toFixed(2)}` : '–';

  return (
    <div className={cn(cardVariants(), "p-4 h-full flex flex-col gap-2.5")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-overline text-success">
          <Tag className="size-3" />
          <span>Price Drops</span>
        </div>
        <Link to="/shopping" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Open →</Link>
      </div>

      {isLoading && products.length === 0 && <Spinner className="text-muted-foreground/30" />}
      {!isLoading && products.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">Track a product to watch its price here.</p>
      )}

      {products.length > 0 && (
        <div className={cn('flex-1', displayMode === 'row' ? 'flex gap-2 overflow-x-auto' : 'space-y-1.5')}>
          {products.map(p => (
            <Link
              key={p.id}
              to={`/shopping/products/${p.id}`}
              className={cn(
                'group flex items-center gap-2 rounded-control border border-border/40 bg-muted/20 p-2 transition-colors hover:bg-muted/40',
                displayMode === 'row' ? 'w-44 shrink-0' : '',
              )}
            >
              {p.imageUrl ? (
                <img src={proxyImg(p.imageUrl)} alt="" className="size-9 shrink-0 rounded object-contain bg-muted" />
              ) : (
                <div className="size-9 shrink-0 rounded bg-muted" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium leading-tight">{p.title}</p>
                <p className="text-[11px] font-semibold text-success">{price(p)}{p.best ? ` · ${p.best.retailerLabel}` : ''}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

const WIDGET_RENDERERS: Record<string, (displayMode: 'row' | 'column') => React.ReactNode> = {
  'weather':            () => <WidgetWeather />,
  'news':               (m) => <WidgetNews displayMode={m} />,
  'jokes':              () => <WidgetJokes />,
  'sports':             () => <WidgetSports />,
  'on-this-day':        () => <WidgetOnThisDay />,
  'morning-briefing':   (m) => <WidgetBriefing displayMode={m} />,
  'yt-subs':            (m) => <WidgetSubs displayMode={m} />,
  'subs-youtube':       (m) => <WidgetYoutubeSubs displayMode={m} />,
  'subs-tiktok':        (m) => <WidgetSourceSubs source="tiktok" displayMode={m} />,
  'subs-vimeo':         (m) => <WidgetSourceSubs source="vimeo" displayMode={m} />,
  'subs-reddit':        (m) => <WidgetSourceSubs source="reddit" displayMode={m} />,
  'video-categories':   () => <WidgetVideoCategories />,
  'music':              () => <WidgetMusic />,
  'price-drops':        (m) => <WidgetPriceDrops displayMode={m} />,
  'bookmarks-recent':   (m) => <WidgetBookmarksRecent displayMode={m} />,
  'bookmarks-queue':    (m) => <WidgetBookmarksQueue displayMode={m} />,
  'podcasts-recent':    (m) => <WidgetPodcastsRecent displayMode={m} />,
  'podcasts-continue':  () => <WidgetPodcastsContinue />,
  'videos-continue':    () => <WidgetVideosContinue />,
  'podcasts-shows':     (m) => <WidgetPodcastsShows displayMode={m} />,
  'watchlist':          (m) => <WidgetWatchlist displayMode={m} />,
  'speed-test-internet':        () => <WidgetSpeedTest mode="internet" />,
  'speed-test-server':          () => <WidgetSpeedTest mode="server" />,
  'speed-test-server-internet': () => <WidgetSpeedTest mode="server-internet" />,
  'status':             () => <WidgetStatus />,
  'ha-summary':         () => <WidgetHASummary />,
  'ha-favorites':       () => <WidgetHAFavorites />,
  'downloads':          () => <DownloadsWidget />,
};

function renderWidget(widget: HomeWidget, mode: 'row' | 'column'): React.ReactNode {
  const id = canonicalWidgetId(widget.toolId);
  const factory = WIDGET_RENDERERS[id];
  if (!factory) return <WidgetUnavailable />;
  // Lowest common render point for every tile (canvas cards + drag overlay):
  // a render throw inside one widget stays contained to that tile instead of
  // bubbling to the app-wide ErrorBoundary and blanking the page.
  return <WidgetErrorBoundary>{factory(mode)}</WidgetErrorBoundary>;
}

// ── Canvas model ──────────────────────────────────────────────────────────────
// A row holds 1–3 widgets. Display mode is derived purely from how many widgets
// share the row: alone → "row" (full-width strip), 2–3 → "column" (compact list).
// There is no stored display flag and no manual toggle — dragging a widget in or
// out of a row is the only thing that flips it. Up to MAX_PER_ROW widgets per row.

const MAX_PER_ROW = 3;

/** Display mode for every widget in a row, from its occupancy. */
function rowMode(row: HomeRow): 'row' | 'column' {
  return row.cols.length <= 1 ? 'row' : 'column';
}

function genRowId(): string {
  return `row-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Locate the (rowIndex, colIndex) of a widget by toolId, or null. */
function locate(rows: HomeRow[], toolId: string): { r: number; c: number } | null {
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r]!.cols.findIndex(col => col.toolId === toolId);
    if (c !== -1) return { r, c };
  }
  return null;
}

/** Keep colSpan roughly in sync with occupancy (1 = full row, else half) and drop empty rows. */
function normalizeRows(rows: HomeRow[]): HomeRow[] {
  return rows
    .filter(r => r.cols.length > 0)
    .map(r => ({
      ...r,
      cols: r.cols.map(c => ({ ...c, colSpan: (r.cols.length === 1 ? 2 : 1) as 1 | 2 })),
    }));
}

// Stable id for the new row spawned mid-drag, so repeated dragOver passes don't
// remount it. Swapped for a real id on drop.
const DRAG_ROW_ID = '__dragging-new-row__';

function sameLayout(a: HomeRow[], b: HomeRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id) return false;
    const ca = a[i]!.cols, cb = b[i]!.cols;
    if (ca.length !== cb.length) return false;
    for (let j = 0; j < ca.length; j++) if (ca[j]!.toolId !== cb[j]!.toolId) return false;
  }
  return true;
}

/**
 * Idempotent next-layout while `activeId` is dragged over `overId`. Operates on
 * the live draft so droppable ids always match what's rendered. Returns the SAME
 * `rows` reference when nothing should change (so the caller can skip setState).
 *
 *   over a sibling card       → reorder within the row
 *   over a card in another row → move into that row at the card's slot (≤ MAX_PER_ROW)
 *   over `before:<rowId>`      → active becomes its own new row above that row
 *   over `end`                 → active becomes its own new row at the bottom
 */
function buildPreview(rows: HomeRow[], activeId: string, overId: string): HomeRow[] {
  const from = locate(rows, activeId);
  if (!from || overId === activeId) return rows;
  const active = rows[from.r]!.cols[from.c]!;

  // ── New-row targets (gaps) ──
  if (overId === 'end' || overId.startsWith('before:')) {
    // Already alone in the drag-row at the requested spot? No-op.
    const dragRowIdx = rows.findIndex(r => r.id === DRAG_ROW_ID);
    const without = normalizeRows(
      rows.map(r => ({ ...r, cols: r.cols.filter(c => c.toolId !== activeId) })),
    );
    const newRow: HomeRow = { id: DRAG_ROW_ID, cols: [active] };
    let next: HomeRow[];
    if (overId === 'end') {
      next = [...without, newRow];
    } else {
      const beforeId = overId.slice('before:'.length);
      const idx = without.findIndex(r => r.id === beforeId);
      next = idx === -1 ? [...without, newRow] : without.toSpliced(idx, 0, newRow);
    }
    // Stabilise: if the drag-row is already where we'd put it, keep current rows.
    if (dragRowIdx !== -1 && sameLayout(rows, next)) return rows;
    return next;
  }

  // ── Card targets ──
  const over = locate(rows, overId);
  if (!over) return rows;
  const sameRow = over.r === from.r;

  if (sameRow) {
    // Reorder within the row.
    if (over.c === from.c) return rows;
    const cols = [...rows[from.r]!.cols];
    cols.splice(from.c, 1);
    cols.splice(over.c, 0, active);
    const next = rows.map((r, i) => (i === from.r ? { ...r, cols } : r));
    return sameLayout(rows, next) ? rows : next;
  }

  // Move into another row before the hovered card.
  if (rows[over.r]!.cols.length >= MAX_PER_ROW) return rows;
  const stripped = rows.map(r => ({ ...r, cols: r.cols.filter(c => c.toolId !== activeId) }));
  const targetIdx = stripped.findIndex(r => r.id === rows[over.r]!.id);
  const cols = [...stripped[targetIdx]!.cols];
  cols.splice(over.c, 0, active);
  stripped[targetIdx] = { ...stripped[targetIdx]!, cols };
  const next = normalizeRows(stripped);
  return sameLayout(rows, next) ? rows : next;
}

// ── Draggable widget card ─────────────────────────────────────────────────────

function WidgetCard({
  widget, mode, editMode, isActive, onRemove,
}: {
  widget: HomeWidget;
  mode: 'row' | 'column';
  editMode: boolean;
  isActive: boolean;
  onRemove: () => void;
}) {
  // Same id registered as both a drag source and a drop target. Kept enabled
  // even while active — buildPreview/onDragOver no-op when hovering yourself.
  const drag = useDraggable({ id: widget.toolId, disabled: !editMode });
  const drop = useDroppable({ id: widget.toolId, disabled: !editMode });
  const setRef = useCallback((el: HTMLElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  }, [drag.setNodeRef, drop.setNodeRef]);

  const meta = getWidgetMeta(widget.toolId);
  const title = meta?.title ?? widget.toolId;

  return (
    <div
      ref={setRef}
      className={cn(
        "relative min-w-0",
        editMode && "cursor-grab touch-none active:cursor-grabbing",
        isActive && "opacity-30",
      )}
      {...(editMode ? drag.attributes : {})}
      {...(editMode ? drag.listeners : {})}
    >
      <div className={cn(editMode && "pointer-events-none select-none")}>
        {renderWidget(widget, mode)}
      </div>
      {editMode && !isActive && (
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={onRemove}
          className="absolute -top-2 -right-2 z-10 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-md hover:brightness-110 transition-all"
          aria-label={`Remove ${title} widget`}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

// One row of 1–3 widgets. The grid track count = occupancy, so a solo widget
// fills the width (row mode) and pairs/triples split into columns (column mode).
function WidgetRow({
  row, editMode, activeId, onRemoveWidget,
}: {
  row: HomeRow;
  editMode: boolean;
  activeId: string | null;
  onRemoveWidget: (toolId: string) => void;
}) {
  const mode = rowMode(row);
  const n = row.cols.length;
  const isMobile = useIsMobile();

  // On phones a 2-/3-track grid squishes each tile to ~110px and its fixed-width
  // thumbnails overflow. Stack every widget full-width instead, and render it in
  // its row/strip mode where supported so it reads as a clean horizontal strip.
  if (isMobile) {
    return (
      <div className="flex flex-col gap-3">
        {row.cols.map(widget => (
          <WidgetCard
            key={widget.toolId}
            widget={widget}
            mode={getWidgetMeta(widget.toolId)?.supportsRowMode ? 'row' : 'column'}
            editMode={editMode}
            isActive={widget.toolId === activeId}
            onRemove={() => onRemoveWidget(widget.toolId)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn(
      "grid gap-3",
      n >= 3 ? "grid-cols-3" : n === 2 ? "grid-cols-2" : "grid-cols-1",
    )}>
      {row.cols.map(widget => (
        <WidgetCard
          key={widget.toolId}
          widget={widget}
          mode={mode}
          editMode={editMode}
          isActive={widget.toolId === activeId}
          onRemove={() => onRemoveWidget(widget.toolId)}
        />
      ))}
    </div>
  );
}

// Drop band between/around rows (including above the first row). Dropping here
// gives the widget its own new full-width row. Idle it's just inter-row spacing;
// while dragging it becomes a clearly visible, easy-to-hit target.
function GapDrop({ id, dragging }: { id: string; dragging: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center justify-center rounded-card text-[11px] font-semibold transition-all",
        !dragging
          ? "h-3"
          : isOver
            ? "my-1.5 h-20 border-2 border-brand bg-brand/15 text-brand"
            : "my-1.5 h-12 border-2 border-dashed border-brand/40 bg-brand/5 text-brand/55",
      )}
    >
      {dragging && (isOver ? "Drop for a new full-width row" : "New row")}
    </div>
  );
}

// ── Canvas zone ───────────────────────────────────────────────────────────────

interface CanvasProps {
  rows: HomeRow[];
  editMode: boolean;
  onChange: (rows: HomeRow[]) => void;
  onRemoveWidget: (toolId: string) => void;
  onAddWidget: () => void;
}

// Pointer-first: target whatever the cursor is literally inside (a card or a
// gap); only fall back to nearest-center when it's over empty space.
const canvasCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter(args);
};

function Canvas({
  rows, editMode, onChange, onRemoveWidget, onAddWidget,
}: CanvasProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  // Live reflowed layout during a drag; committed on drop. Mirrored to a ref so
  // dragEnd reads the latest even if it fires before React re-renders.
  const [preview, setPreview] = useState<HomeRow[] | null>(null);
  const previewRef = useRef<HomeRow[] | null>(null);
  const setPreviewBoth = useCallback((next: HomeRow[] | null | ((p: HomeRow[] | null) => HomeRow[] | null)) => {
    setPreview(prev => {
      const value = typeof next === 'function' ? next(prev) : next;
      previewRef.current = value;
      return value;
    });
  }, []);

  const view = preview ?? rows;
  const activeLoc = activeId ? locate(view, activeId) : null;
  const activeWidget = activeLoc ? view[activeLoc.r]!.cols[activeLoc.c]! : null;
  const activeMode = activeLoc ? rowMode(view[activeLoc.r]!) : 'column';

  // Keep the page from scrolling sideways mid-drag.
  useEffect(() => {
    if (!activeId) return;
    const prev = document.documentElement.style.overflowX;
    document.documentElement.style.overflowX = 'hidden';
    return () => { document.documentElement.style.overflowX = prev; };
  }, [activeId]);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
    setPreviewBoth(rows);
  }

  function handleDragOver(event: DragOverEvent) {
    const activeKey = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || overId === activeKey) return;
    setPreviewBoth(prev => buildPreview(prev ?? rows, activeKey, overId));
  }

  function handleDragEnd() {
    const final = previewRef.current;
    if (final) {
      // Swap the transient drag-row id for a permanent one, then persist.
      const committed = normalizeRows(final).map(r =>
        r.id === DRAG_ROW_ID ? { ...r, id: genRowId() } : r,
      );
      onChange(committed);
    }
    setActiveId(null);
    setPreviewBoth(null);
  }

  function handleDragCancel() {
    setActiveId(null);
    setPreviewBoth(null);
  }

  if (rows.length === 0 && !editMode) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <LayoutGrid className="size-10 text-muted-foreground/20" />
        <p className="text-sm font-medium text-muted-foreground/50">Your home is empty.</p>
        <p className="text-[12px] text-muted-foreground/40">Click Edit to customize.</p>
      </div>
    );
  }

  const dragging = activeId !== null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={canvasCollision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {editMode && (rows.length > 0 || dragging) && (
        <p className="mb-2 text-[11px] text-muted-foreground/45">
          Drag a widget onto another to pair them up (up to 3 across), or into a gap to give it its own full-width row.
        </p>
      )}
      <div className={cn(!editMode && "space-y-8")}>
        {view.map(row => (
          <Fragment key={row.id}>
            {/* No gap directly above the in-flight placeholder row — otherwise the
                pointer hovering it would eject the placeholder and flicker. */}
            {editMode && row.id !== DRAG_ROW_ID && (
              <GapDrop id={`before:${row.id}`} dragging={dragging} />
            )}
            <WidgetRow
              row={row}
              editMode={editMode}
              activeId={activeId}
              onRemoveWidget={onRemoveWidget}
            />
          </Fragment>
        ))}
        {editMode && <GapDrop id="end" dragging={dragging} />}
      </div>
      {editMode && (
        <Button
          onClick={onAddWidget}
          variant="ghost"
          className="mt-4 w-full rounded-card border-dashed border-2 border-border/40 hover:border-brand/60 py-4 h-auto text-[12px] text-muted-foreground/50 hover:text-foreground/70 transition-all"
        >
          <Plus className="size-4" />
          Add widget
        </Button>
      )}
      <DragOverlay dropAnimation={null}>
        {activeWidget ? (
          <div className="rotate-1 opacity-95 shadow-2xl pointer-events-none">
            {renderWidget(activeWidget, activeMode)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}


// ── Featured hero billboard ───────────────────────────────────────────────────
// The editorial lead moment, mirroring the Music/Podcasts/Videos hubs: an
// auto-rotating billboard of the few highest-signal things to resume or read,
// each slide dissolving into an accent extracted from its own artwork. Renders
// nothing until it has at least one art-backed item, so it never shows an empty
// frame on a fresh household.
function HomeBillboard() {
  const { data } = usePodcastFeed();
  const podcastPb = usePodcastPlayback();
  const navigate = useNavigate();
  const [readerMode] = useNewsReaderMode();
  const [news, setNews] = useState<NewsItem[]>([]);

  useEffect(() => {
    fetch("/api/news?limit=8", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { items?: NewsItem[] } | null) => { setNews(d?.items ?? []); })
      .catch(() => {});
  }, []);

  const items = useMemo<ArtBillboardItem[]>(() => {
    const all = data?.all ?? [];
    const cont = continueListening(all).slice(0, 2);
    const contIds = new Set(cont.map(x => x.episode.id));
    const fresh = newEpisodes(all).filter(x => !contIds.has(x.episode.id)).slice(0, 2);
    const newsWithArt = news.filter(n => n.imageUrl && n.url).slice(0, 2);

    const playEpisode = (x: FeedEpisode) => () =>
      podcastPb.play({
        episodeId: x.episode.id, showId: x.show.id, showName: x.show.name,
        title: x.episode.title, coverUrl: coverUrl(x.show.id),
        durationSec: x.episode.durationSec ?? undefined, chapters: x.episode.chapters ?? [],
      });
    const openNews = (url: string) => () => {
      if (readerMode === "reader") navigate(`/news/reader?url=${encodeURIComponent(url)}`);
      else window.open(url, "_blank", "noopener,noreferrer");
    };

    // Best-first: resume where you left off, then a top story with art, then the
    // newest episode. Capped so the carousel stays short and premium.
    // Per-slide eyebrow: "Continue listening" is a history claim, so it rides only
    // on genuine resume items. News and never-played episodes get discovery framing
    // ("Top story" / "New episode"), never language implying you've already been here.
    const out: ArtBillboardItem[] = [];
    for (const x of cont) out.push({
      key: `resume:${x.episode.id}`, title: x.episode.title, subtitle: x.show.name,
      art: coverUrl(x.show.id), onClick: playEpisode(x), pillLabel: "Resume", PillIcon: Play,
      eyebrow: "Continue listening",
    });
    for (const n of newsWithArt) out.push({
      key: `news:${n.url}`, title: n.title, subtitle: n.source ?? "Top story",
      art: proxyImg(n.imageUrl!), onClick: openNews(n.url!), pillLabel: "Read", PillIcon: Newspaper,
      eyebrow: "Top story",
    });
    for (const x of fresh) out.push({
      key: `new:${x.episode.id}`, title: x.episode.title, subtitle: x.show.name,
      art: coverUrl(x.show.id), onClick: playEpisode(x), pillLabel: "Play", PillIcon: Play,
      eyebrow: "New episode",
    });
    return out.slice(0, 5);
  }, [data, news, podcastPb, navigate, readerMode]);

  if (items.length === 0) return null;

  // Each slide carries its own eyebrow (see items above); this is only the fallback,
  // so it stays neutral: "Featured for you" never implies prior history.
  return (
    <div className="px-5 pt-5">
      <ArtBillboard eyebrow="Featured for you" items={items} />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function HomePage() {
  const now = new Date();
  const dateStr = `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;

  const { user } = useAuth();
  const displayName = user ? user.nickname || user.firstName : null;
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const { layout, locked, save, resetToAuto } = useHomeLayout();
  const { tools } = useInstalledTools();
  const { openSpotlight } = useSpotlight();

  // Weather background for the header
  const { snapshot: wxSnap, status: wxStatus } = useWeatherSnapshot();
  const wxLoaded = wxStatus === 'ready' && !!wxSnap;
  const wxGradient: HeroGradient = wxSnap?.info.gradient ?? 'partly-cloudy';
  const wxIsDay = wxSnap?.isDay ?? true;
  const wxHeroBg = wxLoaded ? heroBackground(wxGradient, wxIsDay) : undefined;
  const wxTextClass = wxLoaded ? heroTextClass(wxGradient, wxIsDay) : '';
  const wxLight = wxLoaded && wxTextClass !== SNOW_TEXT;

  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [draftRows, setDraftRows] = useState<HomeRow[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const toolsMap = useMemo(() => {
    const m = new Map<string, { enabled: boolean }>();
    for (const t of tools ?? []) m.set(t.id, t);
    return m;
  }, [tools]);

  usePublishUIContext({
    label: "Home",
    description: `User is on the Home screen (${dateStr}).`,
  });

  // Edit mode helpers — canvas is edited directly as rows of ≤2 widgets.
  const enterEdit = useCallback(() => {
    setDraftRows(layout.canvas.map(r => ({ ...r, cols: r.cols.map(c => ({ ...c })) })));
    setEditMode(true);
  }, [layout.canvas]);

  const cancelEdit = useCallback(() => {
    setEditMode(false);
    setDraftRows([]);
    setPickerOpen(false);
  }, []);

  const saveEdit = useCallback(async () => {
    setIsSaving(true);
    try {
      const canvas = draftRows.filter(r => r.cols.length > 0);
      await save({ ...layout, canvas });
      setEditMode(false);
      setDraftRows([]);
    } catch {
      // Keep edit mode open so the user's arrangement isn't lost, and tell them it didn't save.
      toast.error("Couldn't save your layout — please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [layout, draftRows, save]);

  const handleResetToAuto = useCallback(async () => {
    setConfirmReset(false);
    setIsSaving(true);
    try {
      await resetToAuto();
      setEditMode(false);
      setDraftRows([]);
      toast.success('Home reset to the auto layout.');
    } catch {
      toast.error("Couldn't reset your layout, please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [resetToAuto]);

  const handleRemoveWidget = useCallback((toolId: string) => {
    setDraftRows(prev => normalizeRows(
      prev.map(r => ({ ...r, cols: r.cols.filter(c => c.toolId !== toolId) })),
    ));
  }, []);

  // New widgets land on their own full-width row (row mode); drag them into an
  // existing row afterwards to pair them up.
  const handlePickWidget = useCallback((toolId: string) => {
    setDraftRows(prev => [...prev, { id: genRowId(), cols: [{ toolId, colSpan: 2 as const }] }]);
  }, []);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
  }, []);

  // Collect all widget ids already on the canvas (canonical, for the picker)
  const usedIds = useMemo(() => {
    const rows = editMode ? draftRows : layout.canvas;
    const s = new Set<string>();
    for (const r of rows) for (const c of r.cols) s.add(canonicalWidgetId(c.toolId));
    return s;
  }, [editMode, draftRows, layout.canvas]);

  // A widget is available if it has no gating tool, or that tool is enabled.
  const isWidgetAvailable = useCallback((w: WidgetMeta) => {
    if (!w.toolId) return true;
    const t = toolsMap.get(w.toolId);
    return t ? t.enabled : true;
  }, [toolsMap]);

  const activeRows = editMode ? draftRows : layout.canvas;

  const showJokes   = layout.header.jokes;
  // header.weather was defined but never read; wire it so it actually hides weather.
  const showWeather = layout.header.weather !== false;
  const tickerCfg   = resolveTickerConfig(layout.header);
  const showTicker  = tickerCfg.enabled && tickerCfg.sources.length > 0;

  return (
    <div className="min-h-full bg-background">

      {/* ── Welcome + weather + joke ── */}
      <div
        className="relative flex flex-col gap-4 px-5 pt-8 pb-10 overflow-hidden sm:flex-row sm:items-start sm:justify-between sm:gap-6"
        style={wxHeroBg ? { background: wxHeroBg } : undefined}
      >
        {wxLoaded && <WeatherHeroBg gradient={wxGradient} isDay={wxIsDay} />}
        {/* bottom fade back to page background */}
        {wxLoaded && (
          <div className="absolute inset-x-0 bottom-0 h-16 pointer-events-none z-[1] bg-gradient-to-b from-transparent to-background" />
        )}
        <div className={cn("relative z-10 min-w-0 flex-1", wxLoaded && wxTextClass)}>
          {/* design-ok(raw-palette-semantic): weather-tinted greeting hero text, mirrors components/weather/ scene-text allowlist */}
          <p className={cn("text-[11px] font-semibold uppercase tracking-[0.15em]", wxLight ? "text-white/60" : wxLoaded ? "text-slate-500" : "text-muted-foreground/50")}>
            {dateStr}
          </p>
          {/* design-ok(raw-h1-in-pages): bespoke weather-tinted greeting hero, not a PageHeader page-title (redesign phase 11) */}
          <h1 className={cn("mt-1.5 text-[2rem] font-bold tracking-tight leading-[1.1]", wxLight && "text-white drop-shadow")}>
            {greeting}
            {displayName && (
              <>
                ,{" "}
                {/* design-ok(raw-palette-semantic): weather-tinted greeting hero text, mirrors components/weather/ scene-text allowlist */}
                <span className={wxLight ? "text-white/75" : wxLoaded ? "text-slate-600" : "text-foreground/70"}>{displayName}</span>
              </>
            )}
          </h1>
          {showJokes && <JokeText light={wxLight} />}
          {/* Mobile-only search entry (no top bar on home). Opens the shared Spotlight. */}
          {/* design-ok(hand-styled-button): bespoke search-field affordance, not a ui/Button shape */}
          <button
            type="button"
            onClick={openSpotlight}
            className="mt-4 flex w-full items-center gap-2 rounded-full border border-border/50 bg-card/70 px-4 py-2.5 text-left text-sm text-muted-foreground shadow-sm sm:hidden"
          >
            <Search className="size-4 shrink-0" />
            Search apps, articles, and libraries…
          </button>
        </div>
        {/* Desktop: compact corner widget. Mobile: full-width strip below the greeting. */}
        {showWeather && (
          <>
            <div className="relative z-10 hidden shrink-0 pt-0.5 sm:block">
              <WeatherWidget light={wxLight} />
            </div>
            <div className="relative z-10 sm:hidden">
              <WeatherWidget light={wxLight} variant="strip" />
            </div>
          </>
        )}
      </div>

      {/* ── Ticker ── */}
      {showTicker && <HomeTicker config={tickerCfg} />}

      {/* ── Featured hero ── */}
      <HomeBillboard />

      {/* ── Canvas zone ── */}
      <div className={cn(
        "px-5 py-4 pb-24 relative transition-all",
        editMode && "ring-2 ring-inset ring-brand/40 rounded-card mx-2",
      )}>

        {/* Canvas header: edit controls only. The greeting hero already titles the
            page, so a redundant "My Home" overline is dropped for an editorial feel. */}
        <div className="flex items-center justify-end min-h-6 mb-3">
          {!locked && (
            editMode ? (
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => setConfirmReset(true)}
                  disabled={isSaving}
                  variant="ghost"
                  size="sm"
                  className="h-auto px-3 py-1 text-[11px] font-medium text-muted-foreground/70 hover:text-foreground/80"
                >
                  Reset to auto
                </Button>
                <Button
                  onClick={cancelEdit}
                  variant="outline"
                  size="sm"
                  className="h-auto px-3 py-1 text-[11px] font-medium border-border/40 text-muted-foreground/70 hover:text-foreground/80"
                >
                  Cancel
                </Button>
                <Button
                  onClick={saveEdit}
                  disabled={isSaving}
                  size="sm"
                  className="h-auto px-3 py-1 text-[11px] font-semibold hover:brightness-110"
                >
                  {isSaving && <Spinner size="sm" className="size-3" />}
                  Save
                </Button>
              </div>
            ) : (
              <button
                onClick={enterEdit}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50 hover:text-foreground/70 transition-colors"
              >
                <Pencil className="size-3" />
                Edit
              </button>
            )
          )}
        </div>

        <Canvas
          rows={activeRows}
          editMode={editMode}
          onChange={setDraftRows}
          onRemoveWidget={handleRemoveWidget}
          onAddWidget={openPicker}
        />
      </div>

      {/* ── Widget picker modal ── */}
      {pickerOpen && (
        <WidgetGalleryModal
          usedIds={usedIds}
          isAvailable={isWidgetAvailable}
          onPick={handlePickWidget}
          onClose={() => setPickerOpen(false)}
        />
      )}

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset to the auto layout?"
        description="This discards your custom home layout and rebuilds it automatically from your installed apps. You can always customize it again."
        confirmLabel="Reset"
        onConfirm={() => { void handleResetToAuto(); }}
      />

    </div>
  );
}
