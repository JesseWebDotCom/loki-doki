import {
  CalendarDays, CloudSun, Laugh, Newspaper, Trophy, type LucideIcon,
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
    allowWide: true, toolId: "news",
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
