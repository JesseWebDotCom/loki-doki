import {
  ArrowLeftRight, BookOpen, Brain, CalendarDays, Clapperboard, Clock, CloudSun, Compass,
  Code2, FileType, Gamepad2, Gift, HeartPulse, Home, Image as ImageIcon, Library, Lightbulb,
  Map as MapIcon, MapPin, MessageSquare, Mic, Monitor, Moon, Music, Newspaper, Package, Play,
  Rss, Search, Settings2, Smile, Sparkles, Trophy, Tv, UtensilsCrossed, type LucideIcon,
} from "lucide-react";

export interface AppItem {
  id: string;
  to: string;
  label: string;
  description: string;
  gradient: string;
  /** Solid accent colour used for icons in breadcrumbs, nav, etc. */
  color: string;
  icon: LucideIcon;
  feature?: string;
  /**
   * Backend tool ID from /api/tools. When set, the app is only shown to
   * regular users if the corresponding tool has enabled === true.
   * Apps without this field are always shown (they have no on/off toggle).
   */
  toolId?: string;
}

export interface AppGroup {
  key: string;       // lowercase, used as URL key: /category/ai
  name: string;      // display name: "AI"
  gradient: string;
  /** Solid accent colour used for the group icon in breadcrumbs, nav, etc. */
  color: string;
  icon: LucideIcon;
  apps: AppItem[];
}

export const APP_GROUPS: AppGroup[] = [
  {
    key: "today",
    name: "Today",
    gradient: "linear-gradient(135deg,#1a3a5c,#0f766e)",
    color: "#0d9488",
    icon: Newspaper,
    apps: [
      {
        id: "news",
        to: "/news",
        label: "News",
        description: "Local & global headlines",
        gradient: "linear-gradient(135deg,#1e3a5f,#1a5c4a)",
        color: "#0d9488",
        icon: Newspaper,
        toolId: "news",
      },
      {
        id: "feeds",
        to: "/feeds",
        label: "Feeds",
        description: "Your RSS reader",
        gradient: "linear-gradient(135deg,#7c2d12,#c2410c)",
        color: "#ea580c",
        icon: Rss,
      },
      {
        id: "on-this-day",
        to: "/on-this-day",
        label: "On This Day",
        description: "History made today",
        gradient: "linear-gradient(135deg,#4a1a1a,#7c3a1a)",
        color: "#b45309",
        icon: CalendarDays,
        toolId: "onthisday",
      },
      {
        id: "sports",
        to: "/sports",
        label: "Sports",
        description: "Live scores and matchups",
        gradient: "linear-gradient(135deg,#14532d,#16a34a)",
        color: "#16a34a",
        icon: Trophy,
        toolId: "sports",
      },
      {
        id: "moon-phase",
        to: "/moon-phase",
        label: "Moon Phase",
        description: "Current phase and lunar calendar",
        gradient: "linear-gradient(135deg,#0f172a,#1e293b)",
        color: "#94a3b8",
        icon: Moon,
        toolId: "moonphase",
      },
      {
        id: "holidays",
        to: "/holidays",
        label: "Holidays",
        description: "Public holidays by country",
        gradient: "linear-gradient(135deg,#881337,#be123c)",
        color: "#be123c",
        icon: Gift,
        toolId: "holidays",
      },
      {
        id: "local-events",
        to: "/local-events",
        label: "Local Events",
        description: "Community happenings near you",
        gradient: "linear-gradient(135deg,#3b0764,#7c3aed)",
        color: "#7c3aed",
        icon: MapPin,
        toolId: "localEvents",
      },
    ],
  },
  {
    key: "ai",
    name: "AI",
    gradient: "linear-gradient(135deg,#3a0a72,#db2777)",
    color: "#c026d3",
    icon: Brain,
    apps: [
      { id: "chat",    to: "/chat",    label: "Chat",   description: "AI companion, always offline",   gradient: "linear-gradient(135deg,#3a0a72,#6d28d9)", color: "#7c3aed", icon: MessageSquare },
      { id: "imaging", to: "/imaging", label: "Images", description: "Generate & edit with AI",        gradient: "linear-gradient(135deg,#6d28d9,#db2777)", color: "#db2777", icon: ImageIcon },
      { id: "video",   to: "/video",   label: "Video",  description: "Text & image to video",          gradient: "linear-gradient(135deg,#db2777,#f97316)", color: "#ea580c", icon: Clapperboard },
      { id: "music",   to: "/music",   label: "Music",  description: "Generate & remix music",         gradient: "linear-gradient(135deg,#f97316,#fb923c)", color: "#f97316", icon: Music },
      { id: "skills",  to: "/skills",  label: "Skills", description: "Custom companion behaviors",     gradient: "linear-gradient(135deg,#312e81,#7c3aed)", color: "#7c3aed", icon: Sparkles },
      { id: "voice-memos", to: "/voice-memos", label: "Voice Memos", description: "Record & transcribe notes", gradient: "linear-gradient(135deg,#0c4a6e,#0891b2)", color: "#0891b2", icon: Mic },
    ],
  },
  {
    key: "navigation",
    name: "Navigation",
    gradient: "linear-gradient(135deg,#1f4d35,#1d6fa8)",
    color: "#0284c7",
    icon: Compass,
    apps: [
      { id: "maps",    to: "/maps",    label: "Maps",    description: "Offline world maps", gradient: "linear-gradient(135deg,#163324,#1f4d35)", color: "#16a34a", icon: MapIcon },
      { id: "weather", to: "/weather", label: "Weather", description: "Forecast & alerts",  gradient: "linear-gradient(135deg,#0c2a52,#1d6fa8)", color: "#0284c7", icon: CloudSun, toolId: "weather" },
    ],
  },
  {
    key: "entertainment",
    name: "Entertainment",
    gradient: "linear-gradient(135deg,#3b0d8a,#f97316)",
    color: "#f97316",
    icon: Gamepad2,
    apps: [
      { id: "bored",          to: "/bored",          label: "I'm Bored",      description: "Find something to do",               gradient: "linear-gradient(135deg,#3b0d8a,#7c3aed)", color: "#8b5cf6", icon: Lightbulb },
      { id: "jokes",          to: "/jokes",          label: "Joke of the Day", description: "A fresh dad joke daily",              gradient: "linear-gradient(135deg,#78350f,#d97706)", color: "#d97706", icon: Smile,          toolId: "jokes" },
      { id: "where-to-watch", to: "/where-to-watch", label: "Where to Watch",  description: "Find where to stream any title",      gradient: "linear-gradient(135deg,#1e1b4b,#7c3aed)", color: "#7c3aed", icon: Tv,             toolId: "where-to-watch" },
      { id: "tv-shows",       to: "/tv-shows",       label: "TV Shows",        description: "Search show details and episodes",    gradient: "linear-gradient(135deg,#0c4a6e,#0284c7)", color: "#0284c7", icon: Monitor,        toolId: "tvshows" },
      { id: "youtube",        to: "/youtube",        label: "YouTube",         description: "Search and watch YouTube videos",     gradient: "linear-gradient(135deg,#7f1d1d,#dc2626)", color: "#dc2626", icon: Play,           toolId: "youtube" },
      { id: "podcasts",       to: "/podcasts",       label: "Podcasts",        description: "AI-generated shows from your content", gradient: "linear-gradient(135deg,#0f172a,#6d28d9)", color: "#7c3aed", icon: Mic },
      { id: "recipes",        to: "/recipes",        label: "Recipes",         description: "Discover meals to cook tonight",      gradient: "linear-gradient(135deg,#7c2d12,#ea580c)", color: "#ea580c", icon: UtensilsCrossed, toolId: "recipes" },
      { id: "showtimes",      to: "/showtimes",      label: "Movie Showtimes", description: "Find movies playing near you",        gradient: "linear-gradient(135deg,#1e1b4b,#6d28d9)", color: "#7c3aed", icon: Clapperboard,    toolId: "showtimes" },
    ],
  },
  {
    key: "knowledge",
    name: "Knowledge",
    gradient: "linear-gradient(135deg,#1e1b4b,#1e3a8a)",
    color: "#6366f1",
    icon: Library,
    apps: [
      { id: "docs-user",   to: "/docs/user",   label: "User Guide",          description: "How to use Loki Doki",         gradient: "linear-gradient(135deg,#1e1b4b,#312e81)", color: "#818cf8", icon: BookOpen },
      { id: "docs-dev",    to: "/docs/dev",    label: "Dev Docs",            description: "Architecture & internals",     gradient: "linear-gradient(135deg,#0f172a,#1e3a8a)", color: "#3b82f6", icon: Code2 },
      { id: "dictionary",  to: "/dictionary",  label: "Dictionary",          description: "Word definitions and phonetics", gradient: "linear-gradient(135deg,#1e3a5f,#1d4ed8)", color: "#1d4ed8", icon: BookOpen,   toolId: "dictionary" },
      { id: "medical",     to: "/medical",     label: "Medical Reference",   description: "Look up conditions and medications", gradient: "linear-gradient(135deg,#164e63,#0891b2)", color: "#0891b2", icon: HeartPulse, toolId: "medical" },
    ],
  },
  {
    key: "tools",
    name: "Tools",
    gradient: "linear-gradient(135deg,#166534,#2563eb)",
    color: "#2563eb",
    icon: Settings2,
    apps: [
      { id: "links",          to: "/reader",         label: "Reader",         description: "Bookmarks, links & saved articles", gradient: "linear-gradient(135deg,#14532d,#166534)", color: "#16a34a", icon: BookOpen,        feature: "links" },
      { id: "home-inventory", to: "/home-inventory", label: "Home Inventory", description: "Track devices & appliances",  gradient: "linear-gradient(135deg,#1e3a5f,#2563eb)", color: "#3b82f6", icon: Package,         feature: "home-inventory", toolId: "home_inventory" },
      { id: "home-assistant", to: "/home-assistant", label: "Home Assistant", description: "Control smart home devices",  gradient: "linear-gradient(135deg,#1c1917,#57534e)", color: "#78716c", icon: Home,            feature: "homeAssistant",  toolId: "homeAssistant" },
      { id: "unit-converter", to: "/unit-converter", label: "Unit Converter", description: "Convert length, weight, and more", gradient: "linear-gradient(135deg,#134e4a,#0d9488)", color: "#0d9488", icon: ArrowLeftRight },
      { id: "converter",      to: "/converter",      label: "File Converter", description: "Convert images, audio & video", gradient: "linear-gradient(135deg,#166534,#2563eb)", color: "#2563eb", icon: FileType },
      { id: "time",           to: "/time",           label: "Time",           description: "World clock, alarms & timers", gradient: "linear-gradient(135deg,#0f172a,#4338ca)", color: "#6366f1", icon: Clock, toolId: "time" },
      { id: "reverse-lookup", to: "/reverse-lookup", label: "Reverse Lookup", description: "Property & people by address, name, or phone", gradient: "linear-gradient(135deg,#1e3a5f,#2563eb)", color: "#3b82f6", icon: Search },
    ],
  },
];

export function getAppGroup(key: string): AppGroup | undefined {
  return APP_GROUPS.find(g => g.key === key.toLowerCase());
}

/** Returns the AppItem whose `to` path matches the start of `pathname`. */
export function getAppByPath(pathname: string): AppItem | undefined {
  for (const group of APP_GROUPS) {
    for (const app of group.apps) {
      if (pathname === app.to || pathname.startsWith(app.to + "/")) return app;
    }
  }
  return undefined;
}

/** Returns the AppGroup that contains the app matching `pathname`. */
export function getGroupByAppPath(pathname: string): AppGroup | undefined {
  for (const group of APP_GROUPS) {
    if (group.apps.some(a => pathname === a.to || pathname.startsWith(a.to + "/"))) return group;
  }
  return undefined;
}
