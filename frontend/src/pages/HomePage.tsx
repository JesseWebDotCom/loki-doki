import {
  Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback,
} from "react";
import { Link } from "react-router-dom";
import {
  CalendarDays, Laugh, LayoutGrid,
  Loader2, Maximize2, Minimize2, Newspaper, Pencil, Plus, Trophy, X,
  type LucideIcon,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { NewsRow, type NewsItem } from "@/components/shared/NewsCard";
import { usePublishUIContext } from "@/context/UIContextProvider";
import { useAuth } from "@/context/AuthContext";
import { useWeatherSnapshot } from "@/hooks/useWeatherSnapshot";
import { useHomeLayout, type HomeRow, type HomeWidget } from "@/hooks/useHomeLayout";
import { weatherIconSrc, currentMoonPhase, moonPhaseInfo } from "@/lib/weather";
import { categoryVisual, compareCategories } from "@/lib/archiveCategories";
import { APP_GROUPS } from "@/lib/appCategories";
import { getWidgetMeta, canonicalWidgetId, type WidgetMeta } from "@/lib/homeWidgets";
import { WidgetGalleryModal } from "@/components/home/WidgetGalleryModal";
import { useInstalledTools, isAppVisible } from "@/hooks/useInstalledTools";
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

function WeatherWidget() {
  const { snapshot, status } = useWeatherSnapshot();
  const moon = moonPhaseInfo(currentMoonPhase());
  const isDay = snapshot?.isDay ?? true;

  if (status === "loading") {
    return <Loader2 className="size-4 animate-spin text-muted-foreground/30" />;
  }

  if (status !== "ready" || !snapshot) {
    return (
      <Link to="/weather" className="flex flex-col items-end">
        <span className="text-2xl leading-none">⛅</span>
        <p className="text-[11px] text-muted-foreground mt-0.5">Weather</p>
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
        <span className="text-[2rem] font-black tabular-nums leading-none">{snapshot.temp}°</span>
      </div>
      <p className="text-xs font-medium text-muted-foreground">{snapshot.info.desc}</p>
      <p className="text-[10px] text-muted-foreground/50 max-w-[130px] text-right leading-tight truncate">
        {snapshot.location}
      </p>
    </Link>
  );
}

// ── Joke text (inline below greeting) ────────────────────────────────────────

function JokeText() {
  const [joke, setJoke] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/joke", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { joke?: string | null } | null) => { setJoke(d?.joke ?? null); })
      .catch(() => {});
  }, []);

  if (!joke) return null;
  return (
    <p className="mt-2.5 text-[13px] italic text-muted-foreground/55 leading-snug">
      {joke}
    </p>
  );
}

// ── Sports ticker ─────────────────────────────────────────────────────────────

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

function SportsTicker() {
  const [games, setGames] = useState<GameItem[]>([]);
  const [ready, setReady] = useState(false);
  const innerRef  = useRef<HTMLDivElement>(null);
  const halfRef   = useRef(0);
  const posRef    = useRef(0);
  const modeRef   = useRef<'auto' | 'paused' | 'drag' | 'coast'>('auto');
  const baseSpeed = useRef(0);
  const velRef    = useRef(0);
  const velBuf    = useRef<{ t: number; rawPos: number }[]>([]);
  const dragStartX   = useRef(0);
  const dragStartPos = useRef(0);
  const resumeTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef       = useRef<number>(0);
  const lastT        = useRef(0);

  useEffect(() => {
    fetch("/api/sports/today", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { games?: GameItem[] } | null) => { setGames(d?.games ?? []); })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  useLayoutEffect(() => {
    if (games.length === 0) return;
    const w = innerRef.current?.offsetWidth ?? 0;
    halfRef.current = w / 2;
    if (halfRef.current > 0) {
      const durationMs = Math.max(games.length * 5, 20) * 1000;
      baseSpeed.current = halfRef.current / durationMs;
    }
  }, [games]);

  useEffect(() => {
    if (games.length === 0) return;
    lastT.current = 0;
    modeRef.current = 'auto';
    posRef.current = 0;

    const wrap = (p: number) => {
      const h = halfRef.current;
      return h > 0 ? ((p % h) + h) % h : 0;
    };

    const tick = (t: number) => {
      if (lastT.current === 0) lastT.current = t;
      const dt = Math.min(t - lastT.current, 50);
      lastT.current = t;

      const inner = innerRef.current;
      if (inner && halfRef.current > 0) {
        const mode = modeRef.current;
        if (mode === 'auto') {
          const breathe = 1 + 0.12 * Math.sin(t * 0.00035);
          posRef.current = wrap(posRef.current + baseSpeed.current * breathe * dt);
        } else if (mode === 'coast') {
          posRef.current = wrap(posRef.current + velRef.current * dt);
          velRef.current *= Math.pow(FRICTION, dt / 16);
          if (Math.abs(velRef.current) < MIN_MOMENTUM) {
            velRef.current = 0;
            modeRef.current = 'paused';
            scheduleResume();
          }
        }
        inner.style.transform = `translateX(${-posRef.current}px)`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [games]);

  useEffect(() => () => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
  }, []);

  function scheduleResume() {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => {
      if (modeRef.current !== 'drag') modeRef.current = 'auto';
      resumeTimer.current = null;
    }, RESUME_DELAY_MS);
  }
  function cancelResume() {
    if (resumeTimer.current) { clearTimeout(resumeTimer.current); resumeTimer.current = null; }
  }
  function endDrag() {
    if (modeRef.current !== 'drag') return;
    const now = Date.now();
    const recent = velBuf.current.filter(v => now - v.t <= 80);
    velRef.current = 0;
    if (recent.length >= 2) {
      const a = recent[0]!, b = recent[recent.length - 1]!;
      const dt = b.t - a.t;
      if (dt > 0) velRef.current = (b.rawPos - a.rawPos) / dt;
    }
    velBuf.current = [];
    if (Math.abs(velRef.current) > MIN_MOMENTUM) {
      modeRef.current = 'coast';
    } else {
      modeRef.current = 'paused';
      scheduleResume();
    }
  }

  if (!ready || games.length === 0) return null;
  const doubled = [...games, ...games];

  return (
    <div className="flex items-center border-y border-border/25" style={{ background: "rgba(16,185,129,0.03)" }}>
      <div className="shrink-0 flex items-center gap-1.5 px-4 border-r border-border/25 self-stretch py-2">
        <Trophy className="size-3 text-emerald-400" />
        <span className="text-[9px] font-black uppercase tracking-[0.16em] text-emerald-400 whitespace-nowrap">Scores</span>
      </div>
      <div
        className="flex-1 py-2 select-none overflow-hidden cursor-grab active:cursor-grabbing"
        onMouseEnter={() => {
          cancelResume();
          if (modeRef.current === 'auto') modeRef.current = 'paused';
        }}
        onMouseLeave={() => {
          if (modeRef.current === 'paused') scheduleResume();
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          cancelResume();
          velRef.current = 0;
          velBuf.current = [];
          dragStartX.current   = e.clientX;
          dragStartPos.current = posRef.current;
          modeRef.current = 'drag';
          e.preventDefault();
        }}
        onPointerMove={(e) => {
          if (modeRef.current !== 'drag') return;
          const rawPos = dragStartPos.current + (dragStartX.current - e.clientX);
          const h = halfRef.current;
          posRef.current = h > 0 ? ((rawPos % h) + h) % h : rawPos;
          const now = Date.now();
          velBuf.current.push({ t: now, rawPos });
          const cutoff = now - 100;
          velBuf.current = velBuf.current.filter(v => v.t >= cutoff);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          ref={innerRef}
          className="flex items-center will-change-transform"
          style={{ width: 'max-content' }}
        >
          {doubled.map((g, i) => {
            const { league, teams, status, isFinal, isLive } = parseGame(g.title);
            return (
              <span key={i} className="inline-flex items-center gap-2 px-5 whitespace-nowrap">
                {league && (
                  <span className="text-[13px] leading-none" title={league}>
                    {SPORT_EMOJI[league] ?? '🏆'}
                  </span>
                )}
                <span className="text-[11px] font-medium text-foreground/75">{teams}</span>
                {status && (
                  <span className={cn(
                    "text-[10px]",
                    isLive ? "font-semibold text-emerald-400" : isFinal ? "text-muted-foreground/45" : "text-muted-foreground/55",
                  )}>
                    {isFinal ? "Final" : status}
                  </span>
                )}
                <span className="text-border/50 ml-1">·</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
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

function WidgetNews() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/news?limit=3", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { items?: NewsItem[] } | null) => { setItems(d?.items ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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

function WidgetUnavailable() {
  return (
    <div className="rounded-xl border border-dashed border-border/40 bg-card/40 p-4 h-full flex flex-col items-center justify-center gap-1.5 text-center">
      <LayoutGrid className="size-5 text-muted-foreground/25" />
      <p className="text-[11px] text-muted-foreground/40">Widget unavailable</p>
    </div>
  );
}

// ── Widget renderers ──────────────────────────────────────────────────────────
// Keyed by canonical widget id (see lib/homeWidgets). The catalog there is the
// source of truth for which widgets exist; this map just wires ids to views.

const WIDGET_RENDERERS: Record<string, () => React.ReactNode> = {
  'weather':      () => <WidgetWeather />,
  'news':         () => <WidgetNews />,
  'jokes':        () => <WidgetJokes />,
  'sports':       () => <WidgetSports />,
  'on-this-day':  () => <WidgetOnThisDay />,
};

function renderWidget(toolId: string): React.ReactNode {
  const factory = WIDGET_RENDERERS[canonicalWidgetId(toolId)];
  return factory ? factory() : <WidgetUnavailable />;
}

// ── Canvas model helpers ──────────────────────────────────────────────────────
// Stored & edited as rows of ≤2 widgets. Drop-target ids are namespaced:
//   row:<rowId>   → drop into that row (pair up)
//   gap:<rowId>   → insert a new row *before* that row
//   gap:end       → insert a new row at the bottom

function genRowId(): string {
  return `row-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function findWidget(rows: HomeRow[], toolId: string): HomeWidget | undefined {
  for (const r of rows) { const c = r.cols.find(c => c.toolId === toolId); if (c) return c; }
  return undefined;
}

function rowFull(row: HomeRow): boolean {
  return row.cols.some(c => c.colSpan === 2) || row.cols.length >= 2;
}

/** Remove a widget from wherever it lives; drop now-empty rows. */
function removeFromRows(rows: HomeRow[], toolId: string): HomeRow[] {
  return rows
    .map(r => ({ ...r, cols: r.cols.filter(c => c.toolId !== toolId) }))
    .filter(r => r.cols.length > 0);
}

/** Move a widget into an existing row (pairing). No-op if it can't fit. */
function dropIntoRow(rows: HomeRow[], toolId: string, rowId: string): HomeRow[] {
  const moving = findWidget(rows, toolId);
  const target = rows.find(r => r.id === rowId);
  if (!moving || !target) return rows;
  if (target.cols.some(c => c.toolId === toolId)) return rows; // already here
  if (moving.colSpan === 2 || rowFull(target)) return rows;
  const narrow = { ...moving, colSpan: 1 as const };
  return removeFromRows(rows, toolId).map(r =>
    r.id === rowId ? { ...r, cols: [...r.cols, narrow] } : r,
  );
}

/** Move a widget into a new row inserted before `beforeRowId` (or at the end). */
function dropIntoNewRow(rows: HomeRow[], toolId: string, beforeRowId: string | null): HomeRow[] {
  const moving = findWidget(rows, toolId);
  if (!moving) return rows;
  const without = removeFromRows(rows, toolId);
  const newRow: HomeRow = { id: genRowId(), cols: [moving] };
  if (beforeRowId === null) return [...without, newRow];
  const idx = without.findIndex(r => r.id === beforeRowId);
  if (idx === -1) return [...without, newRow];
  const next = [...without];
  next.splice(idx, 0, newRow);
  return next;
}

// ── Draggable widget ──────────────────────────────────────────────────────────

function DraggableWidget({
  widget, editMode, canToggleWide, onRemove, onToggleWide,
}: {
  widget: HomeWidget;
  editMode: boolean;
  canToggleWide: boolean;
  onRemove: () => void;
  onToggleWide: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: widget.toolId, disabled: !editMode });

  const meta = getWidgetMeta(widget.toolId);
  const title = meta?.title ?? widget.toolId;
  const isWide = widget.colSpan === 2;

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative",
        isWide ? "col-span-2" : "col-span-1",
        editMode && "cursor-grab touch-none active:cursor-grabbing",
        isDragging && "z-20",
      )}
      {...(editMode ? attributes : {})}
      {...(editMode ? listeners : {})}
    >
      <div className={cn(editMode && "pointer-events-none select-none")}>
        {renderWidget(widget.toolId)}
      </div>
      {editMode && (
        <>
          {canToggleWide && (
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={onToggleWide}
              className="absolute -top-2 -left-2 z-10 flex size-5 items-center justify-center rounded-full bg-brand text-white shadow-md hover:brightness-110 transition-all"
              aria-label={isWide ? `Make ${title} narrow` : `Make ${title} full width`}
              title={isWide ? "Shrink to half width" : "Expand to full width"}
            >
              {isWide ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
            </button>
          )}
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={onRemove}
            className="absolute -top-2 -right-2 z-10 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-md hover:brightness-110 transition-all"
            aria-label={`Remove ${title} widget`}
          >
            <X className="size-3" />
          </button>
        </>
      )}
    </div>
  );
}

// ── Insert line between rows ──────────────────────────────────────────────────

function InsertLine({ id, active }: { id: string; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  // Resting: a small gap between rows. While dragging: a thin guide line.
  // While hovered: opens into a full row-height "new row" space.
  return (
    <div
      ref={setNodeRef}
      className={cn("flex items-center transition-all", isOver ? "h-[88px] py-1" : active ? "h-6" : "h-3")}
    >
      {isOver ? (
        <div className="flex h-full w-full items-center justify-center rounded-xl border-2 border-dashed border-brand bg-brand/10 text-[11px] font-semibold text-brand">
          New row
        </div>
      ) : (
        <div className={cn("h-0.5 w-full rounded-full transition-all", active ? "bg-border/50" : "bg-transparent")} />
      )}
    </div>
  );
}

// ── Droppable row ─────────────────────────────────────────────────────────────

function DroppableRow({
  row, editMode, canAccept, onRemoveWidget, onToggleWide,
}: {
  row: HomeRow;
  editMode: boolean;
  canAccept: boolean;
  onRemoveWidget: (toolId: string) => void;
  onToggleWide: (toolId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `row:${row.id}`, disabled: !editMode });
  const solo = row.cols.length === 1 && row.cols[0].colSpan !== 2;
  const pairing = isOver && canAccept;

  return (
    <div ref={setNodeRef} className="grid grid-cols-2 gap-3 rounded-xl">
      {row.cols.map(widget => {
        const meta = getWidgetMeta(widget.toolId);
        return (
          <DraggableWidget
            key={widget.toolId}
            widget={widget}
            editMode={editMode}
            canToggleWide={!!meta?.allowWide}
            onRemove={() => onRemoveWidget(widget.toolId)}
            onToggleWide={() => onToggleWide(widget.toolId)}
          />
        );
      })}
      {editMode && solo && (
        <div
          className={cn(
            "col-span-1 flex min-h-[80px] items-center justify-center rounded-xl border-2 border-dashed text-[11px] font-medium transition-all",
            pairing
              ? "border-brand bg-brand/10 text-brand"
              : "border-border/30 text-muted-foreground/30",
          )}
        >
          {pairing ? "Pair here" : "drop here to pair"}
        </div>
      )}
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
  onToggleWide: (toolId: string) => void;
}

function Canvas({
  rows, editMode,
  onChange, onRemoveWidget, onAddWidget, onToggleWide,
}: CanvasProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  const [activeId, setActiveId] = useState<string | null>(null);

  const activeWidget = activeId ? findWidget(rows, activeId) ?? null : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;
    const dragId = String(active.id);
    const overId = String(over.id);

    if (overId.startsWith("gap:")) {
      const before = overId.slice(4);
      onChange(dropIntoNewRow(rows, dragId, before === "end" ? null : before));
    } else if (overId.startsWith("row:")) {
      onChange(dropIntoRow(rows, dragId, overId.slice(4)));
    }
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
  // A row can accept the dragged widget if there's an open narrow slot.
  const canAcceptInRow = (row: HomeRow) =>
    !!activeWidget && activeWidget.colSpan !== 2 && !rowFull(row) &&
    !row.cols.some(c => c.toolId === activeId);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {editMode && rows.length > 0 && (
        <p className="mb-2 text-[11px] text-muted-foreground/45">
          Drag a widget onto another to pair them, or onto a blue line to drop it on its own row. Use ⤢ for full width.
        </p>
      )}
      <div className={cn(!editMode && "space-y-3")}>
        {rows.map(row => (
          <Fragment key={row.id}>
            {editMode && <InsertLine id={`gap:${row.id}`} active={dragging} />}
            <DroppableRow
              row={row}
              editMode={editMode}
              canAccept={canAcceptInRow(row)}
              onRemoveWidget={onRemoveWidget}
              onToggleWide={onToggleWide}
            />
          </Fragment>
        ))}
        {editMode && <InsertLine id="gap:end" active={dragging} />}
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
          <div className="rotate-1 opacity-95 shadow-2xl">
            {renderWidget(activeWidget.toolId)}
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
    setDraftRows(prev => removeFromRows(prev, toolId));
  }, []);

  // Toggling a widget to full width splits it onto its own row when it shares one.
  const handleToggleWide = useCallback((toolId: string) => {
    setDraftRows(prev => {
      const row = prev.find(r => r.cols.some(c => c.toolId === toolId));
      const col = row?.cols.find(c => c.toolId === toolId);
      if (!row || !col) return prev;
      const makingWide = col.colSpan !== 2;

      if (makingWide && row.cols.length > 1) {
        const remaining: HomeRow = { ...row, cols: row.cols.filter(c => c.toolId !== toolId) };
        const wideRow: HomeRow = { id: genRowId(), cols: [{ ...col, colSpan: 2 }] };
        return prev.flatMap(r => (r.id === row.id ? [remaining, wideRow] : [r]));
      }
      return prev.map(r =>
        r.id !== row.id ? r : {
          ...r,
          cols: r.cols.map(c =>
            c.toolId === toolId ? { ...c, colSpan: makingWide ? (2 as const) : (1 as const) } : c,
          ),
        },
      );
    });
  }, []);

  const handlePickWidget = useCallback((toolId: string) => {
    setDraftRows(prev => [...prev, { id: genRowId(), cols: [{ toolId, colSpan: 1 as const }] }]);
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
  const showSports  = layout.header.sports;

  return (
    <div className="min-h-full bg-background">

      {/* ── Welcome + weather + joke ── */}
      <div className="flex items-start justify-between gap-6 px-5 pt-8 pb-5">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/50">
            {dateStr}
          </p>
          <h1 className="mt-1.5 text-[2rem] font-black tracking-tight leading-[1.1]">
            {greeting}
            {displayName && (
              <>
                ,{" "}
                <span className="text-foreground/70">{displayName}</span>
              </>
            )}
          </h1>
          {showJokes && <JokeText />}
        </div>
        <div className="shrink-0 pt-0.5">
          <WeatherWidget />
        </div>
      </div>

      {/* ── Sports ticker ── */}
      {showSports && <SportsTicker />}

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
          onToggleWide={handleToggleWide}
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
