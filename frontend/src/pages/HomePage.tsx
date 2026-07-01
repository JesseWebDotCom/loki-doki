import {
  Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity, Bookmark, CalendarDays, CirclePlay, CloudSun, Gauge, Heart, Headphones, Laugh, LayoutGrid,
  ListVideo, Loader2, Music, Newspaper, Pencil, Play, PlaySquare, Plus, RotateCw, Sunrise, Trophy, Tv,
  Upload, X, type LucideIcon,
} from "lucide-react";
import type { VideoItem } from "@/lib/youtube/types";
import { useQuery } from "@tanstack/react-query";
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
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { NewsRow, type NewsItem } from "@/components/shared/NewsCard";
import { usePublishUIContext } from "@/context/UIContextProvider";
import { useAuth } from "@/context/AuthContext";
import { useWeatherSnapshot } from "@/hooks/useWeatherSnapshot";
import { useHomeLayout, resolveTickerConfig, type HomeRow, type HomeWidget, type TickerConfig, type TickerSource } from "@/hooks/useHomeLayout";
import { weatherIconSrc, currentMoonPhase, moonPhaseInfo, heroBackground, heroTextClass, SNOW_TEXT, type HeroGradient } from "@/lib/weather";
import { WeatherHeroBg } from "@/components/weather/WeatherHeroBg";
import { categoryVisual, compareCategories } from "@/lib/archiveCategories";
import { APP_GROUPS } from "@/lib/appCategories";
import { getWidgetMeta, canonicalWidgetId, type WidgetMeta } from "@/lib/homeWidgets";
import { WidgetGalleryModal } from "@/components/home/WidgetGalleryModal";
import { useYtFeed } from "@/lib/youtube/useData";
import { watchHref } from "@/components/youtube/VideoCard";
import { fmtAge } from "@/lib/youtube/format";
import { ytImageProxy } from "@/lib/youtube/api";
import { proxyImg } from "@/lib/img";
import { getHistory, getFavorites, listStations, stationToDj, type Station } from "@/lib/music/catalogApi";
import { useRadio } from "@/context/RadioContext";
import { usePodcastFeed, continueListening, newEpisodes } from "@/lib/podcast/useFeed";
import { coverUrl } from "@/lib/podcast/api";
import { usePodcastPlayback } from "@/context/PodcastPlaybackContext";
import { useYoutubePlayback } from "@/context/YoutubePlaybackContext";
import type { BookmarkItem } from "@/lib/bookmarks/api";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
import {
  DEFAULT_THRESHOLDS, RATING_META, fmtMbps, fmtMs, loadLastResult, loadMode, loadThresholds,
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

interface ToolMeta {
  id: string
  name: string
  enabled: boolean
  offline?: boolean
}

// ── Compact weather widget (header) ──────────────────────────────────────────

function WeatherWidget({ light }: { light?: boolean }) {
  const { snapshot, status } = useWeatherSnapshot();
  const moon = moonPhaseInfo(currentMoonPhase());
  const isDay = snapshot?.isDay ?? true;

  const textMuted = light ? "text-white/80" : "text-muted-foreground";
  const textFaint = light ? "text-white/55" : "text-muted-foreground/50";

  if (status === "loading") {
    return <Loader2 className={cn("size-4 animate-spin", light ? "text-white/40" : "text-muted-foreground/30")} />;
  }

  if (status !== "ready" || !snapshot) {
    return (
      <Link to="/weather" className="flex flex-col items-end">
        <span className="text-2xl leading-none">⛅</span>
        <p className={cn("text-[11px] mt-0.5", textMuted)}>Weather</p>
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
        <span className={cn("text-[2rem] font-black tabular-nums leading-none", light && "text-white drop-shadow")}>{snapshot.temp}°</span>
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
    fetch("/api/joke", { credentials: "include" })
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

const SPORT_EMOJI: Record<string, string> = {
  'MLB':       '⚾',
  'NFL':       '🏈',
  'NBA':       '🏀',
  'NHL':       '🏒',
  'MLS':       '⚽',
  'World Cup': '⚽',
  'NCAAF':     '🏈',
  'NCAAB':     '🏀',
  'WNBA':      '🏀',
  'CFL':       '🏈',
  'EPL':       '⚽',
  'UEFA':      '⚽',
}

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

const SECTION_STYLES: Record<TickerSource, { Icon: React.ElementType; accent: string; bg: string; label: string }> = {
  sports:  { Icon: Trophy,      accent: 'text-emerald-400', bg: 'bg-emerald-500/[0.09]', label: 'Scores'   },
  youtube: { Icon: PlaySquare,  accent: 'text-red-400',     bg: 'bg-red-500/[0.09]',     label: 'YouTube'  },
  news:    { Icon: Newspaper,   accent: 'text-sky-400',     bg: 'bg-sky-500/[0.09]',     label: 'News'     },
  podcast: { Icon: Headphones,  accent: 'text-violet-400',  bg: 'bg-violet-500/[0.09]',  label: 'Podcasts' },
}

function SectionBadge({ source }: { source: TickerSource }) {
  const { Icon, accent, label } = SECTION_STYLES[source]
  return (
    <span className="inline-flex items-center gap-1.5 px-3 border-r border-border/20 self-stretch shrink-0">
      <Icon className={cn('size-3 shrink-0', accent)} />
      <span className={cn('text-[9px] font-black uppercase tracking-[0.14em] whitespace-nowrap', accent)}>{label}</span>
    </span>
  )
}

function TickerItemChip({ item, onPointerDown }: { item: TickerItem; onPointerDown: () => void }) {
  if (item.type === 'sports') {
    const { league, teams, status, isFinal, isLive } = parseGame(item.title)
    return (
      <span className="inline-flex items-center gap-2 px-4 whitespace-nowrap" onPointerDown={onPointerDown}>
        {league && <span className="text-[13px] leading-none" title={league}>{SPORT_EMOJI[league] ?? '🏆'}</span>}
        <span className="text-[11px] font-medium text-foreground/75">{teams}</span>
        {status && (
          <span className={cn("text-[10px]", isLive ? "font-semibold text-emerald-400" : isFinal ? "text-muted-foreground/45" : "text-muted-foreground/55")}>
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
        <span className="text-[11px] font-medium text-foreground/75 group-hover:text-foreground transition-colors max-w-[220px] truncate">{item.title}</span>
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
          <div className={cn("shrink-0 overflow-hidden rounded-sm bg-muted", item.imageUrl ? "size-[13px]" : "size-[16px]")}>
            <img src={proxyImg(`https://www.google.com/s2/favicons?domain=${item.faviconHost}&sz=32`)} alt="" loading="lazy" className="size-full object-cover" />
          </div>
        ) : !item.imageUrl && (
          <Newspaper className="size-3 text-sky-400/60 shrink-0" />
        )}
        <span className="text-[11px] font-medium text-foreground/75 group-hover:text-foreground transition-colors max-w-[260px] truncate">{item.title}</span>
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
        <span className="text-[11px] font-medium text-foreground/75 group-hover:text-foreground transition-colors max-w-[240px] truncate">{item.title}</span>
        <span className="text-border/40 ml-1">·</span>
      </span>
    )
  }
  return null
}

function HomeTicker({ config }: { config: TickerConfig }) {
  const ytPb = useYoutubePlayback()
  const podcastPb = usePodcastPlayback()
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
        window.open(item.url, '_blank', 'noopener,noreferrer')
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

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 text-xs font-bold uppercase tracking-widest text-muted-foreground/50 mb-3">
      {children}
    </p>
  );
}

function parseOtdYear(title: string): { year: string; text: string } {
  const m = title.match(/^(\d{1,4})\s*[—–]\s*(.+)$/);
  return m ? { year: m[1]!, text: m[2]! } : { year: "", text: title };
}

function TodaysHeadlines() {
  const [local, setLocal] = useState<NewsItem | null>(null);
  const [world, setWorld] = useState<NewsItem | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const top = (type: string) =>
      fetch(`/api/news?type=${type}&limit=1`, { credentials: "include" })
        .then(r => r.ok ? r.json() : null)
        .then((d: { items?: NewsItem[] } | null) => d?.items?.[0] ?? null)
        .catch(() => null);
    Promise.all([top("local"), top("world")]).then(([l, w]) => {
      if (cancelled) return;
      setLocal(l); setWorld(w); setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label>Today's Headlines</Label>
        {loading
          ? <Loader2 className="size-3 animate-spin text-muted-foreground/30" />
          : <Link to="/news" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
        }
      </div>
      {!loading && !local && !world ? (
        <p className="text-[11px] text-muted-foreground/50">No headlines available.</p>
      ) : (
        <div className="space-y-0.5">
          {local && <NewsRow item={local} tag="Local" tagColor="rgb(45,212,191)" />}
          {world && <NewsRow item={world} tag="Global" tagColor="rgb(96,165,250)" />}
        </div>
      )}
    </div>
  );
}

function OtdCard() {
  const [items, setItems] = useState<OtdItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/on-this-day", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { events?: OtdItem[] } | null) => { setItems(d?.events?.slice(0, 3) ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="rounded-2xl overflow-hidden border flex flex-col" style={{ background: "rgba(245,158,11,0.05)", borderColor: "rgba(245,158,11,0.15)" }}>
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b" style={{ borderColor: "rgba(245,158,11,0.12)" }}>
        <div className="flex items-center gap-1.5">
          <CalendarDays className="size-3.5 text-amber-400" />
          <span className="text-[10px] font-black uppercase tracking-[0.14em] text-amber-400">On This Day</span>
        </div>
        {loading
          ? <Loader2 className="size-3 animate-spin text-muted-foreground/30" />
          : <Link to="/on-this-day" className="text-[10px] text-amber-400/55 hover:text-amber-400 transition-colors">See all →</Link>
        }
      </div>
      <div className="flex-1 px-3.5 py-2.5 space-y-2.5">
        {!loading && items.length === 0 && (
          <p className="text-[11px] text-muted-foreground/50">Nothing for today.</p>
        )}
        {items.map((item, i) => {
          const { year, text } = parseOtdYear(item.title);
          return (
            <div key={i} className="flex items-start gap-2">
              {year && (
                <span className="text-[12px] font-black text-amber-400 tabular-nums leading-tight shrink-0 pt-px">
                  {year}
                </span>
              )}
              <p className="text-[11px] leading-snug text-foreground/70 line-clamp-2">{text}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Canvas widgets ────────────────────────────────────────────────────────────

function WidgetWeather() {
  const { snapshot, status } = useWeatherSnapshot();

  return (
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground/50">
        <span>⛅</span>
        <span>Weather</span>
      </div>
      {status === "loading" && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {status === "no-location" && (
        <p className="text-[12px] text-muted-foreground/60">No location set. Configure in Settings.</p>
      )}
      {status === "ready" && snapshot && (
        <Link to="/weather" className="flex items-center gap-3 group">
          <img src={weatherIconSrc(snapshot.info.icon)} className="size-10 shrink-0" alt="" />
          <div>
            <p className="text-2xl font-black tabular-nums leading-none">{snapshot.temp}°</p>
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

  return (
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground/50">
          <Newspaper className="size-3" />
          <span>News</span>
        </div>
        <Link to="/news" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      {loading && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!loading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No news available.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {items.map((item, i) => (
            <a
              key={i}
              href={item.url ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="group shrink-0 w-[180px] flex flex-col gap-1.5"
            >
              {item.imageUrl ? (
                <div className="w-full aspect-video overflow-hidden rounded-lg bg-muted">
                  <img
                    src={item.imageUrl} alt="" loading="lazy"
                    className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                  />
                </div>
              ) : (
                <div className="w-full aspect-video rounded-lg bg-muted/60 flex items-center justify-center">
                  <Newspaper className="size-6 text-muted-foreground/20" />
                </div>
              )}
              <p className="line-clamp-3 text-[11px] font-semibold leading-snug text-foreground/85">{item.title}</p>
              {item.source && (
                <p className="truncate text-[10px] text-muted-foreground/55">{item.source}</p>
              )}
            </a>
          ))}
        </div>
      ) : (
        <div className="space-y-0.5 flex-1">
          {items.map((item, i) => (
            <NewsRow key={i} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetJokes() {
  const [joke, setJoke] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/joke", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { joke?: string | null } | null) => { setJoke(d?.joke ?? null); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground/50">
        <Laugh className="size-3" />
        <span>Joke of the Day</span>
      </div>
      {loading && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
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
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground/50">
        <Trophy className="size-3 text-emerald-400" />
        <span className="text-emerald-400">Scores</span>
      </div>
      {loading && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!loading && games.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No games today.</p>
      )}
      <div className="space-y-1.5 flex-1">
        {games.slice(0, 6).map((g, i) => {
          const { league, teams, status, isFinal, isLive } = parseGame(g.title);
          return (
            <div key={i} className="flex items-center gap-2">
              {league && (
                <span className="text-[13px] leading-none shrink-0" title={league}>
                  {SPORT_EMOJI[league] ?? '🏆'}
                </span>
              )}
              <span className="text-[11px] font-medium text-foreground/75 flex-1 min-w-0 truncate">{teams}</span>
              {status && (
                <span className={cn(
                  "text-[10px] shrink-0",
                  isLive ? "font-semibold text-emerald-400" : isFinal ? "text-muted-foreground/45" : "text-muted-foreground/55",
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
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-amber-400">
        <CalendarDays className="size-3" />
        <span>On This Day</span>
      </div>
      {loading && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!loading && parsed && (
        <div className="flex items-start gap-2 flex-1">
          {parsed.year && (
            <span className="text-[14px] font-black text-amber-400 tabular-nums leading-tight shrink-0 pt-px">
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

interface BriefingItem { title: string; detail?: string; url?: string }
interface BriefingPayload {
  date: string;
  weather?: string;
  localNews: BriefingItem[];
  worldNews: BriefingItem[];
  sports: BriefingItem[];
  onThisDay: BriefingItem[];
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

  const topStory = payload?.localNews[0] ?? payload?.worldNews[0];
  const topScore = payload?.sports[0];
  const otd = payload?.onThisDay[0];
  const empty = !loading && !payload;

  const header = (
    <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-amber-400">
      <Sunrise className="size-3" />
      <span>Morning Briefing</span>
    </div>
  );

  if (displayMode === 'row') {
    const cards: { label: string; icon: LucideIcon; text: string; url?: string }[] = [];
    if (payload?.weather) cards.push({ label: 'Weather', icon: CloudSun, text: payload.weather });
    if (topStory) cards.push({ label: 'Top Story', icon: Newspaper, text: topStory.title, url: topStory.url });
    if (topScore) cards.push({ label: 'Scores', icon: Trophy, text: topScore.title });
    if (otd) cards.push({ label: 'On This Day', icon: CalendarDays, text: otd.title });

    return (
      <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
        {header}
        {(loading || warming) && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
        {empty && <p className="text-[12px] text-muted-foreground/60">No briefing available yet.</p>}
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {cards.map((c, i) => {
            const Icon = c.icon;
            const inner = (
              <div className="group shrink-0 w-[180px] flex flex-col gap-1.5 rounded-lg bg-muted/40 p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground/60">
                  <Icon className="size-3" /><span>{c.label}</span>
                </div>
                <p className="line-clamp-3 text-[11px] font-medium leading-snug text-foreground/85">{c.text}</p>
              </div>
            );
            return c.url
              ? <a key={i} href={c.url} target="_blank" rel="noopener noreferrer">{inner}</a>
              : <div key={i}>{inner}</div>;
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      {header}
      {(loading || warming) && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {empty && <p className="text-[12px] text-muted-foreground/60">No briefing available yet.</p>}
      {payload && (
        <div className="space-y-1.5 flex-1">
          {payload.weather && (
            <div className="flex items-center gap-1.5 text-[12px] text-foreground/75">
              <CloudSun className="size-3.5 shrink-0 text-sky-400" /><span className="truncate">{payload.weather}</span>
            </div>
          )}
          {topStory && (
            <p className="line-clamp-2 text-[12px] leading-snug text-foreground/70">{topStory.title}</p>
          )}
          {topScore && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Trophy className="size-3 shrink-0 text-emerald-400" /><span className="truncate">{topScore.title}</span>
            </div>
          )}
          {otd && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
              <CalendarDays className="size-3 shrink-0 text-amber-400" /><span className="truncate">{otd.title}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Standard YouTube thumbnail for a video id, routed through the same-origin cache.
const ytThumb = (videoId: string) => ytImageProxy(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);

function WidgetYoutubeSubs({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const feedLimit = displayMode === 'row' ? 10 : 6;
  const showCount = displayMode === 'row' ? 8 : 4;
  const { items, loading } = useYtFeed(feedLimit);
  const vids = items.slice(0, showCount);

  return (
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-red-500">
          <PlaySquare className="size-3" />
          <span>Subscriptions</span>
        </div>
        <Link to="/youtube" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      {loading && vids.length === 0 && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!loading && vids.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No recent uploads. Subscribe to channels in YouTube.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {vids.map((v: VideoItem) => {
            const age = v.ageLabel ?? fmtAge(v.publishedAt);
            return (
              <Link key={v.videoId} to={watchHref(v)} className="group shrink-0 w-[160px] flex flex-col gap-1.5">
                <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-muted">
                  <img
                    src={ytThumb(v.videoId)} alt="" loading="lazy"
                    className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                  />
                </div>
                <p className="line-clamp-2 text-[11px] font-semibold leading-snug text-foreground/85">{v.title}</p>
                <p className="truncate text-[10px] text-muted-foreground/55">
                  {v.author}{v.author && age ? " · " : ""}{age}
                </p>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2 flex-1">
          {vids.map((v: VideoItem) => {
            const age = v.ageLabel ?? fmtAge(v.publishedAt);
            return (
              <Link key={v.videoId} to={watchHref(v)} className="group flex gap-2.5">
                <div className="relative aspect-video w-[88px] shrink-0 overflow-hidden rounded-lg bg-muted">
                  <img
                    src={ytThumb(v.videoId)} alt="" loading="lazy"
                    className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[12px] font-semibold leading-snug text-foreground/85">{v.title}</p>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60">
                    {v.author}{v.author && age ? " · " : ""}{age}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
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
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-orange-400">
          <Music className="size-3" />
          <span>Music</span>
        </div>
        <Link to="/music" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Open →</Link>
      </div>

      {histLoading && empty && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!histLoading && empty && (
        <p className="text-[12px] text-muted-foreground/60">Start a station to see it here.</p>
      )}

      {favStations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {favStations.map(s => (
            <button
              key={s.id}
              onClick={() => radio.start(stationToDj(s))}
              className="flex items-center gap-1 rounded-full border border-orange-400/25 bg-orange-400/10 px-2.5 py-1 text-[11px] font-semibold text-orange-300/90 transition-colors hover:bg-orange-400/20"
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
            <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">Recently played</p>
          )}
          {recents.map(t => (
            <button
              key={t.id}
              onClick={() => radio.playTrack({ videoId: t.videoId, title: t.title, author: t.artist ?? undefined, thumbnail: ytThumb(t.videoId) })}
              className="group flex w-full items-center gap-2.5 text-left"
            >
              <img src={ytThumb(t.videoId)} alt="" loading="lazy" className="size-9 shrink-0 rounded-md object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold leading-snug text-foreground/85">{t.title}</p>
                {t.artist && <p className="truncate text-[10px] text-muted-foreground/60">{t.artist}</p>}
              </div>
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
      .then((d: { items?: BookmarkItem[] } | null) => { setItems((d?.items ?? []).slice(0, show)); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [limit, show]);

  const fmtDomain = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

  return (
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-violet-400">
          <Bookmark className="size-3" />
          <span>Bookmarks</span>
        </div>
        <Link to="/bookmarks" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      {loading && items.length === 0 && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!loading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No bookmarks yet. Save an article to see it here.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {items.map(b => (
            <Link key={b.id} to={`/bookmarks/${b.id}`} className="group shrink-0 w-[160px] flex flex-col gap-1.5">
              <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-muted flex items-center justify-center">
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
              <div className="size-9 shrink-0 rounded-md bg-muted overflow-hidden flex items-center justify-center">
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

function WidgetPodcastsRecent({ displayMode = 'column' }: { displayMode?: 'row' | 'column' }) {
  const { data, isLoading } = usePodcastFeed();
  const podcast = usePodcastPlayback();
  const show   = displayMode === 'row' ? 8 : 4;
  const items  = newEpisodes(data?.all ?? []).slice(0, show);

  return (
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-indigo-400">
          <Headphones className="size-3" />
          <span>New Episodes</span>
        </div>
        <Link to="/podcasts" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">See all →</Link>
      </div>
      {isLoading && items.length === 0 && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!isLoading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No episodes yet. Generate one from a podcast show.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {items.map(({ episode, show: s }) => (
            <button key={episode.id} onClick={() => podcast.play({ episodeId: episode.id, showId: s.id, showName: s.name, title: episode.title, durationSec: episode.durationSec ?? undefined, coverUrl: coverUrl(s.id) })} className="group shrink-0 w-[140px] flex flex-col gap-1.5 text-left">
              <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted">
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
              <img src={coverUrl(s.id)} alt="" loading="lazy" className="size-9 shrink-0 rounded-md object-cover" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[12px] font-semibold leading-snug text-foreground/85">{episode.title}</p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60">{s.name}</p>
              </div>
              <Play className="size-3.5 shrink-0 text-indigo-400 opacity-0 transition-opacity group-hover:opacity-100" />
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
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-teal-400">
          <CirclePlay className="size-3" />
          <span>Continue Listening</span>
        </div>
        <Link to="/podcasts" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Library →</Link>
      </div>
      {isLoading && items.length === 0 && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!isLoading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">Start listening to an episode to resume it here.</p>
      )}
      <div className="space-y-2 flex-1">
        {items.map(({ episode, show: s }) => {
          const pct = fmtProgress(episode.watchState?.positionSec ?? 0, episode.durationSec);
          return (
            <button key={episode.id} onClick={() => podcast.play({ episodeId: episode.id, showId: s.id, showName: s.name, title: episode.title, durationSec: episode.durationSec ?? undefined, coverUrl: coverUrl(s.id) }, episode.watchState?.positionSec)} className="group flex gap-2.5 items-center text-left w-full">
              <img src={coverUrl(s.id)} alt="" loading="lazy" className="size-9 shrink-0 rounded-md object-cover" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="line-clamp-1 text-[12px] font-semibold leading-snug text-foreground/85">{episode.title}</p>
                <p className="truncate text-[10px] text-muted-foreground/60">{s.name}</p>
                {pct != null && (
                  <div className="h-0.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-teal-400" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              <Play className="size-3.5 shrink-0 text-teal-400 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
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
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-rose-400">
          <Tv className="size-3" />
          <span>Watchlist</span>
        </div>
        <Link to="/shows" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Browse →</Link>
      </div>
      {loading && items.length === 0 && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!loading && items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No watchlist yet. Add shows or movies to track them.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {items.map(item => (
            <Link key={item.id} to={itemHref(item)} className="group shrink-0 w-[100px] flex flex-col gap-1.5">
              <div className="relative w-full overflow-hidden rounded-lg bg-muted" style={{ aspectRatio: '2/3' }}>
                {item.posterUrl
                  ? <img src={item.posterUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
                  : <Tv className="absolute inset-0 m-auto size-6 text-muted-foreground/25" />
                }
                <span className="absolute top-1 right-1 rounded-sm bg-black/60 px-1 py-px text-[9px] font-bold uppercase text-white/80">
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
              <div className="relative w-[36px] shrink-0 overflow-hidden rounded-md bg-muted flex items-center justify-center" style={{ aspectRatio: '2/3' }}>
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
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-violet-300">
          <ListVideo className="size-3" />
          <span>My Shows</span>
        </div>
        <Link to="/podcasts/library" className="text-[10px] text-muted-foreground/45 hover:text-foreground/70 transition-colors">Library →</Link>
      </div>
      {isLoading && shows.length === 0 && <Loader2 className="size-4 animate-spin text-muted-foreground/30" />}
      {!isLoading && shows.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">No shows yet. Create one in the Podcasts app.</p>
      )}
      {displayMode === 'row' ? (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
          {shows.map(s => (
            <Link key={s.id} to={`/podcasts/show/${s.id}`} className="group shrink-0 w-[120px] flex flex-col gap-1.5">
              <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted">
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
              <img src={coverUrl(s.id)} alt="" loading="lazy" className="size-9 shrink-0 rounded-md object-cover" />
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
    <div className="rounded-xl border border-dashed border-border/40 bg-card/40 p-4 h-full flex flex-col items-center justify-center gap-1.5 text-center">
      <LayoutGrid className="size-5 text-muted-foreground/25" />
      <p className="text-[11px] text-muted-foreground/40">Widget unavailable</p>
    </div>
  );
}

function WidgetSpeedTest() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [thresholds, setThresholds] = useState<SpeedThresholds>(DEFAULT_THRESHOLDS);
  const [mode, setMode] = useState<SpeedMode>('internet');
  const [result, setResult] = useState<SpeedResult | null>(null);
  const [phase, setPhase] = useState<SpeedPhase>('idle');
  const [live, setLive] = useState(0);
  const running = phase !== 'idle' && phase !== 'done';
  const runningRef = useRef(false);

  useEffect(() => {
    void loadThresholds().then(setThresholds);
    if (!user?.id) return;
    void loadMode(user.id).then(setMode);
    void loadLastResult(user.id).then(r => { if (r) setResult(r); });
  }, [user?.id]);

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
    <div className="rounded-xl border border-border/40 bg-card p-4 h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-cyan-400">
          <Gauge className="size-3" />
          <span>Speed Test</span>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="text-cyan-400/70 hover:text-cyan-400 transition-colors disabled:opacity-50"
          title="Run speed test"
        >
          {running
            ? <Loader2 className="size-3.5 animate-spin" />
            : <RotateCw className="size-3.5" />}
        </button>
      </div>

      {running ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-1">
          <span className="text-3xl font-black tabular-nums text-cyan-400">{fmtMbps(live)}</span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/55">
            {phase === 'upload' ? 'Upload Mbps' : phase === 'ping' ? 'Pinging…' : 'Download Mbps'}
          </span>
        </div>
      ) : result ? (
        <button onClick={() => navigate('/speed-test')} className="flex-1 flex flex-col justify-center gap-2 text-left">
          <div className="flex items-baseline gap-1.5">
            <span className={cn('text-3xl font-black tabular-nums', rating && RATING_META[rating].text)}>
              {fmtMbps(result.downloadMbps)}
            </span>
            <span className="text-[11px] font-semibold text-muted-foreground/55">Mbps down</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
            <span className="flex items-center gap-1"><Upload className="size-3" />{fmtMbps(result.uploadMbps)}</span>
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
            className={`flex flex-col items-center justify-center gap-1 rounded-xl border p-2 text-center text-xs font-medium transition-colors disabled:opacity-60 ${
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
          className="flex flex-col items-center justify-center gap-1 rounded-xl border border-border/50 p-2 text-center text-xs font-medium text-muted-foreground hover:bg-muted/40 transition-colors disabled:opacity-60"
        >
          <span className="text-lg">✕</span>
          <span>Clear</span>
        </button>
      </div>
    </div>
  )
}

// ── Widget renderers ──────────────────────────────────────────────────────────
// Keyed by canonical widget id (see lib/homeWidgets). The catalog there is the
// source of truth for which widgets exist; this map just wires ids to views.

const WIDGET_RENDERERS: Record<string, (displayMode: 'row' | 'column') => React.ReactNode> = {
  'weather':            () => <WidgetWeather />,
  'news':               (m) => <WidgetNews displayMode={m} />,
  'jokes':              () => <WidgetJokes />,
  'sports':             () => <WidgetSports />,
  'on-this-day':        () => <WidgetOnThisDay />,
  'morning-briefing':   (m) => <WidgetBriefing displayMode={m} />,
  'yt-subs':            (m) => <WidgetYoutubeSubs displayMode={m} />,
  'music':              () => <WidgetMusic />,
  'bookmarks-recent':   (m) => <WidgetBookmarksRecent displayMode={m} />,
  'podcasts-recent':    (m) => <WidgetPodcastsRecent displayMode={m} />,
  'podcasts-continue':  () => <WidgetPodcastsContinue />,
  'podcasts-shows':     (m) => <WidgetPodcastsShows displayMode={m} />,
  'watchlist':          (m) => <WidgetWatchlist displayMode={m} />,
  'speed-test':         () => <WidgetSpeedTest />,
  'status':             () => <WidgetStatus />,
};

function renderWidget(widget: HomeWidget, mode: 'row' | 'column'): React.ReactNode {
  const id = canonicalWidgetId(widget.toolId);
  const factory = WIDGET_RENDERERS[id];
  return factory ? factory(mode) : <WidgetUnavailable />;
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
        "flex items-center justify-center rounded-xl text-[11px] font-semibold transition-all",
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
      <div className={cn(!editMode && "space-y-3")}>
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
        <button
          onClick={onAddWidget}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border-dashed border-2 border-border/40 hover:border-brand/60 py-4 text-[12px] text-muted-foreground/50 hover:text-foreground/70 transition-all"
        >
          <Plus className="size-4" />
          Add widget
        </button>
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

// ── Category tile ─────────────────────────────────────────────────────────────

function CategoryTile({
  to, gradient, icon: Icon, label, count,
}: {
  to: string; gradient: string; icon: LucideIcon; label: string; count: number;
}) {
  const meta = `${count} ${count === 1 ? "item" : "items"}`;
  return (
    <Link
      to={to}
      className="group relative h-24 overflow-hidden rounded-2xl shimmer-sweep transition-all hover:brightness-110 hover:scale-[1.02] active:scale-[0.97]"
      style={{ background: gradient }}
    >
      <Icon
        className="absolute -bottom-3 -right-2 size-[72px] text-white/[0.28] pointer-events-none transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-hover:scale-110 group-hover:rotate-[-28deg] rotate-[-20deg]"
      />
      <div className="absolute top-0 left-0 p-3.5 z-10">
        <span className="text-[15px] font-extrabold text-white leading-snug tracking-tight">{label}</span>
        <p className="text-[11px] text-white/60 leading-snug mt-0.5">{meta}</p>
      </div>
    </Link>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface InstalledArchive {
  id: string; sourceId: string; category: string; fileSizeBytes: number | null;
}
interface CategorySummary {
  category: string; count: number; totalBytes: number;
}

export function HomePage() {
  const now = new Date();
  const dateStr = `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;

  const { user } = useAuth();
  const displayName = user ? user.nickname || user.firstName : null;
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const { layout, locked, save } = useHomeLayout();
  const { enabledToolIds } = useInstalledTools();

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
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Archives + app features for categories
  const [archives, setArchives] = useState<InstalledArchive[]>([]);
  const [appFeatures, setAppFeatures] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch("/api/tools", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: ToolMeta[] | null) => { setTools(d ?? []); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/archives/installed", { credentials: "include" })
        .then(r => r.json())
        .then(d => { if (!cancelled) setArchives((d as { archives?: InstalledArchive[] }).archives ?? []); })
        .catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    return () => { cancelled = true; window.removeEventListener("focus", load); };
  }, []);

  useEffect(() => {
    fetch("/api/app-features", { credentials: "include" })
      .then(r => r.json())
      .then(d => setAppFeatures(d as Record<string, boolean>))
      .catch(() => {});
  }, []);

  const toolsMap = useMemo(() => {
    const m = new Map<string, ToolMeta>();
    for (const t of tools) m.set(t.id, t);
    return m;
  }, [tools]);

  const libCategories = useMemo<CategorySummary[]>(() => {
    const byCat = new Map<string, CategorySummary>();
    for (const a of archives) {
      const cur = byCat.get(a.category) ?? { category: a.category, count: 0, totalBytes: 0 };
      cur.count += 1; cur.totalBytes += a.fileSizeBytes ?? 0;
      byCat.set(a.category, cur);
    }
    return [...byCat.values()].sort((x, y) => compareCategories(x.category, y.category));
  }, [archives]);

  const categories = useMemo(() => {
    const appGroupTiles = APP_GROUPS.flatMap(group => {
      const visibleApps = group.apps.filter(
        a =>
          (!a.feature || appFeatures[a.feature] !== false) &&
          isAppVisible(a.toolId, enabledToolIds),
      );
      const matchingLib = libCategories.find(lc => lc.category.toLowerCase() === group.key);
      const total = visibleApps.length + (matchingLib?.count ?? 0);
      if (total === 0) return [];
      return [{
        key: group.key,
        name: group.name,
        gradient: group.gradient,
        icon: group.icon,
        count: total,
      }];
    });

    const usedKeys = new Set(APP_GROUPS.map(g => g.key));
    const libOnlyTiles = libCategories
      .filter(lc => !usedKeys.has(lc.category.toLowerCase()))
      .map(lc => {
        const v = categoryVisual(lc.category);
        return {
          key: lc.category.toLowerCase(),
          name: lc.category,
          gradient: v.gradient,
          icon: v.icon,
          count: lc.count,
        };
      });

    return [...appGroupTiles, ...libOnlyTiles];
  }, [libCategories, appFeatures, enabledToolIds]);

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
    } finally {
      setIsSaving(false);
    }
  }, [layout, draftRows, save]);

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
  const tickerCfg   = resolveTickerConfig(layout.header);
  const showTicker  = tickerCfg.enabled && tickerCfg.sources.length > 0;

  return (
    <div className="min-h-full bg-background">

      {/* ── Welcome + weather + joke ── */}
      <div
        className="relative flex items-start justify-between gap-6 px-5 pt-8 pb-10 overflow-hidden"
        style={wxHeroBg ? { background: wxHeroBg } : undefined}
      >
        {wxLoaded && <WeatherHeroBg gradient={wxGradient} isDay={wxIsDay} />}
        {/* bottom fade back to page background */}
        {wxLoaded && (
          <div className="absolute inset-x-0 bottom-0 h-16 pointer-events-none z-[1] bg-gradient-to-b from-transparent to-background" />
        )}
        <div className={cn("relative z-10 min-w-0 flex-1", wxLoaded && wxTextClass)}>
          <p className={cn("text-[11px] font-semibold uppercase tracking-[0.15em]", wxLight ? "text-white/60" : wxLoaded ? "text-slate-500" : "text-muted-foreground/50")}>
            {dateStr}
          </p>
          <h1 className={cn("mt-1.5 text-[2rem] font-black tracking-tight leading-[1.1]", wxLight && "text-white drop-shadow")}>
            {greeting}
            {displayName && (
              <>
                ,{" "}
                <span className={wxLight ? "text-white/75" : wxLoaded ? "text-slate-600" : "text-foreground/70"}>{displayName}</span>
              </>
            )}
          </h1>
          {showJokes && <JokeText light={wxLight} />}
        </div>
        <div className="relative z-10 shrink-0 pt-0.5">
          <WeatherWidget light={wxLight} />
        </div>
      </div>

      {/* ── Ticker ── */}
      {showTicker && <HomeTicker config={tickerCfg} />}

      {/* ── Canvas zone ── */}
      <div className={cn(
        "px-5 py-4 pb-24 relative transition-all",
        editMode && "ring-2 ring-inset ring-brand/40 rounded-xl mx-2",
      )}>

        {/* Canvas header with edit controls */}
        <div className="flex items-center justify-between mb-4">
          <Label>My Home</Label>
          {!locked && (
            editMode ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={cancelEdit}
                  className="px-3 py-1 text-[11px] font-medium rounded-lg border border-border/40 text-muted-foreground/70 hover:text-foreground/80 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold rounded-lg bg-brand text-white hover:brightness-110 disabled:opacity-50 transition-all"
                >
                  {isSaving && <Loader2 className="size-3 animate-spin" />}
                  Save
                </button>
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

    </div>
  );
}
