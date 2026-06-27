import {
  Bookmark, CalendarDays, CirclePlay, CloudSun, Gauge, Headphones, Laugh, ListVideo, Music,
  Newspaper, PlaySquare, Trophy, Tv, type LucideIcon,
} from "lucide-react";

/**
 * Catalog of every real home-screen widget. This is the single source of
 * truth: the widget picker, the placed-widget chrome, and the admin layout
 * editor all read from here. A widget only exists if it has an entry below —
 * which is what keeps the picker from ever offering a "coming soon" tile.
 */
export interface WidgetMeta {
  /** Stable id stored in saved layouts. Must match a renderer key in HomePage. */
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Solid accent colour for the glyph. */
  color: string;
  /** Gradient used for the iOS-style icon tile in the picker. */
  gradient: string;
  /** Whether the widget can be resized to a full-width (2-column) tile. */
  allowWide: boolean;
  /** Backend tool id from /api/tools that gates availability. Omit = always on. */
  toolId?: string;
  /** Teaser: shown dimmed + non-addable in the picker. */
  comingSoon?: boolean;
  /**
   * When true, expanding this widget to full-width (colSpan=2) switches it to
   * a horizontal card-strip "row" layout instead of a vertical list.
   */
  supportsRowMode?: boolean;
}

export const HOME_WIDGETS: WidgetMeta[] = [
  {
    id: "weather", title: "Weather",
    description: "Current conditions & temperature",
    icon: CloudSun, color: "#0ea5e9",
    gradient: "linear-gradient(135deg,#0c2a52,#1d6fa8)",
    allowWide: true, toolId: "weather",
  },
  {
    id: "news", title: "News",
    description: "Latest local & global headlines",
    icon: Newspaper, color: "#14b8a6",
    gradient: "linear-gradient(135deg,#1e3a5f,#1a5c4a)",
    allowWide: true, toolId: "news", supportsRowMode: true,
  },
  {
    id: "sports", title: "Scores",
    description: "Today's games and live scores",
    icon: Trophy, color: "#22c55e",
    gradient: "linear-gradient(135deg,#14532d,#16a34a)",
    allowWide: true, toolId: "sports",
  },
  {
    id: "on-this-day", title: "On This Day",
    description: "A moment from history, today",
    icon: CalendarDays, color: "#f59e0b",
    gradient: "linear-gradient(135deg,#4a1a1a,#7c3a1a)",
    allowWide: true, toolId: "onthisday",
  },
  {
    id: "jokes", title: "Joke of the Day",
    description: "A fresh laugh every day",
    icon: Laugh, color: "#d97706",
    gradient: "linear-gradient(135deg,#78350f,#d97706)",
    allowWide: false, toolId: "jokes",
  },
  {
    id: "yt-subs", title: "Subscriptions",
    description: "Latest from your YouTube subscriptions",
    icon: PlaySquare, color: "#dc2626",
    gradient: "linear-gradient(135deg,#7f1d1d,#dc2626)",
    allowWide: true, toolId: "youtube", supportsRowMode: true,
  },
  {
    id: "music", title: "Music",
    description: "Recently played & favorite stations",
    icon: Music, color: "#f97316",
    gradient: "linear-gradient(135deg,#f97316,#fb923c)",
    allowWide: true,
  },
  {
    id: "bookmarks-recent", title: "Bookmarks",
    description: "Recently saved articles & links",
    icon: Bookmark, color: "#8b5cf6",
    gradient: "linear-gradient(135deg,#3b0764,#7c3aed)",
    allowWide: true, supportsRowMode: true,
  },
  {
    id: "podcasts-recent", title: "New Episodes",
    description: "Latest episodes from your podcast shows",
    icon: Headphones, color: "#6366f1",
    gradient: "linear-gradient(135deg,#1e1b4b,#4338ca)",
    allowWide: true, supportsRowMode: true,
  },
  {
    id: "podcasts-continue", title: "Continue Listening",
    description: "Pick up where you left off",
    icon: CirclePlay, color: "#14b8a6",
    gradient: "linear-gradient(135deg,#042f2e,#0f766e)",
    allowWide: true,
  },
  {
    id: "watchlist", title: "Watchlist",
    description: "Shows & movies you want to watch",
    icon: Tv, color: "#f43f5e",
    gradient: "linear-gradient(135deg,#4c0519,#be123c)",
    allowWide: true, supportsRowMode: true,
  },
  {
    id: "podcasts-shows", title: "My Shows",
    description: "Your podcast library at a glance",
    icon: ListVideo, color: "#a78bfa",
    gradient: "linear-gradient(135deg,#2e1065,#6d28d9)",
    allowWide: true, supportsRowMode: true,
  },
  {
    id: "speed-test", title: "Speed Test",
    description: "Latest connection speed to your server",
    icon: Gauge, color: "#06b6d4",
    gradient: "linear-gradient(135deg,#0c2a52,#0891b2)",
    allowWide: false,
  },
];

/** Legacy stored ids → current catalog ids (e.g. raw tool ids from old layouts). */
const ALIASES: Record<string, string> = {
  onthisday: "on-this-day",
};

const BY_ID = new Map(HOME_WIDGETS.map(w => [w.id, w]));

/** Resolve a stored widget id (honouring aliases) to its canonical id. */
export function canonicalWidgetId(id: string): string {
  return BY_ID.has(id) ? id : (ALIASES[id] ?? id);
}

export function getWidgetMeta(id: string): WidgetMeta | undefined {
  return BY_ID.get(canonicalWidgetId(id));
}
