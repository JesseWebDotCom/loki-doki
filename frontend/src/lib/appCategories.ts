import {
  ArrowLeftRight, BookAudio, BookMarked, BookOpen, CalendarDays, Camera, Clapperboard, Clock, CloudSun, Compass,
  Code2, FileType, Film, Gauge, Gift, Globe, Home, Image as ImageIcon, Lightbulb,
  Languages, Map as MapIcon, MapPin, MessageSquare, Mic, Moon, Music, Newspaper, Package,
  Search, Settings2, Share2, Smile, Sparkles, StickyNote, Tag, TerminalSquare, Trophy, Tv, UtensilsCrossed, Users, Zap, type LucideIcon,
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
  key: string;       // lowercase, used as URL key: /category/entertainment
  name: string;      // display name: "Entertainment"
  gradient: string;
  /** Solid accent colour used for the group icon in breadcrumbs, nav, etc. */
  color: string;
  icon: LucideIcon;
  apps: AppItem[];
}

// App Store-style taxonomy: categories describe what the user does with the
// app (watch, read, cook, fix), not how it's built (no "AI" bucket, since
// nearly everything here is AI-powered). Group order = chip/store display order.
export const APP_GROUPS: AppGroup[] = [
  {
    key: "entertainment",
    name: "Entertainment",
    gradient: "linear-gradient(135deg,#3b0d8a,#f97316)",
    color: "#f97316",
    icon: Clapperboard,
    apps: [
      { id: "shows",          to: "/shows",          label: "Shows",           description: "Discover TV series: streaming, trailers & reviews", gradient: "linear-gradient(135deg,#0c4a6e,#0284c7)", color: "#0284c7", icon: Tv,             toolId: "tvshows" },
      { id: "movies",         to: "/movies",         label: "Movies",          description: "Discover films: streaming, showtimes, trailers & reviews", gradient: "linear-gradient(135deg,#1e1b4b,#6d28d9)", color: "#7c3aed", icon: Clapperboard, toolId: "showtimes" },
      { id: "videos",         to: "/videos",         label: "Videos",          description: "Watch, save & create videos", gradient: "linear-gradient(135deg,#164e63,#06b6d4)", color: "#06b6d4", icon: Film,           toolId: "youtube" },
      { id: "music",          to: "/music",          label: "Music",           description: "Listen, discover & create",     gradient: "linear-gradient(135deg,#f97316,#fb923c)", color: "#f97316", icon: Music },
      { id: "podcasts",       to: "/podcasts",       label: "Podcasts",        description: "AI-generated shows from your content", gradient: "linear-gradient(135deg,#0f172a,#6d28d9)", color: "#7c3aed", icon: Mic },
      { id: "where-to-watch", to: "/where-to-watch", label: "Where to Watch",  description: "Find where to stream any title",      gradient: "linear-gradient(135deg,#1e1b4b,#7c3aed)", color: "#7c3aed", icon: Tv,             toolId: "where-to-watch" },
      { id: "bored",          to: "/bored",          label: "I'm Bored",       description: "Find something to do",                gradient: "linear-gradient(135deg,#3b0d8a,#7c3aed)", color: "#8b5cf6", icon: Lightbulb },
      { id: "jokes",          to: "/jokes",          label: "Joke of the Day", description: "A fresh dad joke daily",              gradient: "linear-gradient(135deg,#78350f,#d97706)", color: "#d97706", icon: Smile,          toolId: "jokes" },
    ],
  },
  {
    key: "news",
    name: "News & Sports",
    gradient: "linear-gradient(135deg,#1a3a5c,#0f766e)",
    color: "#0d9488",
    icon: Newspaper,
    apps: [
      { id: "news",        to: "/news",        label: "News",        description: "Headlines & your RSS feeds",      gradient: "linear-gradient(135deg,#1e3a5f,#1a5c4a)", color: "#0d9488", icon: Newspaper,    toolId: "news" },
      { id: "sports",      to: "/sports",      label: "Sports",      description: "Live scores and matchups",        gradient: "linear-gradient(135deg,#14532d,#16a34a)", color: "#16a34a", icon: Trophy,       toolId: "sports" },
      { id: "on-this-day", to: "/on-this-day", label: "On This Day", description: "History made today",              gradient: "linear-gradient(135deg,#4a1a1a,#7c3a1a)", color: "#b45309", icon: CalendarDays, toolId: "onthisday" },
    ],
  },
  {
    key: "creativity",
    name: "Creativity",
    gradient: "linear-gradient(135deg,#6d28d9,#db2777)",
    color: "#db2777",
    icon: ImageIcon,
    apps: [
      { id: "imaging", to: "/imaging", label: "Images", description: "Generate & edit with AI",                          gradient: "linear-gradient(135deg,#6d28d9,#db2777)", color: "#db2777", icon: ImageIcon },
      { id: "canvas",  to: "/canvas",  label: "Canvas", description: "Editable docs & code the companion writes for you", gradient: "linear-gradient(135deg,#3b1a5c,#7c3aed)", color: "#8b5cf6", icon: Sparkles },
    ],
  },
  {
    key: "companions",
    name: "Companions",
    gradient: "linear-gradient(135deg,#3a0a72,#db2777)",
    color: "#c026d3",
    icon: Users,
    apps: [
      { id: "chat",       to: "/chat",       label: "Chat",       description: "AI companion, always offline",    gradient: "linear-gradient(135deg,#3a0a72,#6d28d9)", color: "#7c3aed", icon: MessageSquare },
      { id: "companions", to: "/companions", label: "Companions", description: "Browse and customize companions", gradient: "linear-gradient(135deg,#1d4ed8,#7c3aed)", color: "#6366f1", icon: Users },
      { id: "skills",     to: "/skills",     label: "Skills",     description: "Custom companion behaviors",      gradient: "linear-gradient(135deg,#312e81,#7c3aed)", color: "#7c3aed", icon: Sparkles },
    ],
  },
  {
    key: "reading",
    name: "Reading & Reference",
    gradient: "linear-gradient(135deg,#1e1b4b,#1e3a8a)",
    color: "#6366f1",
    icon: BookOpen,
    apps: [
      { id: "books",     to: "/books",     label: "Books",      description: "Read and listen to books",                  gradient: "linear-gradient(135deg,#422006,#a16207)", color: "#ca8a04", icon: BookAudio,  feature: "books" },
      { id: "reference", to: "/reference", label: "Reference",  description: "Wikipedia, dictionary, medical & more",     gradient: "linear-gradient(135deg,#1e1b4b,#1e3a8a)", color: "#6366f1", icon: BookMarked, feature: "reference" },
      { id: "bookmarks", to: "/bookmarks", label: "Bookmarks",  description: "Saved links, articles & offline archives",  gradient: "linear-gradient(135deg,#14532d,#166534)", color: "#16a34a", icon: BookOpen,   feature: "bookmarks" },
      { id: "docs-user", to: "/docs/user", label: "User Guide", description: "How to use Loki Doki",                      gradient: "linear-gradient(135deg,#1e1b4b,#312e81)", color: "#818cf8", icon: BookOpen },
    ],
  },
  {
    key: "lifestyle",
    name: "Lifestyle",
    gradient: "linear-gradient(135deg,#7c2d12,#be123c)",
    color: "#ea580c",
    icon: Gift,
    apps: [
      { id: "calendar",     to: "/calendar",     label: "Calendar",     description: "The family's iCloud calendars, together", gradient: "linear-gradient(135deg,#7f1d1d,#ef4444)", color: "#ef4444", icon: CalendarDays,   feature: "icloud-calendar" },
      { id: "recipes",      to: "/recipes",      label: "Recipes",      description: "Discover meals to cook tonight",   gradient: "linear-gradient(135deg,#7c2d12,#ea580c)", color: "#ea580c", icon: UtensilsCrossed, toolId: "recipes" },
      { id: "shopping",     to: "/shopping",     label: "Shop",         description: "Compare prices & catch drops",     gradient: "linear-gradient(135deg,#14532d,#0d9488)", color: "#10b981", icon: Tag,             toolId: "shopping" },
      { id: "local-events", to: "/local-events", label: "Local Events", description: "Community happenings near you",   gradient: "linear-gradient(135deg,#3b0764,#7c3aed)", color: "#7c3aed", icon: MapPin,          toolId: "localEvents" },
      { id: "holidays",     to: "/holidays",     label: "Holidays",     description: "Public holidays by country",      gradient: "linear-gradient(135deg,#881337,#be123c)", color: "#be123c", icon: Gift,            toolId: "holidays" },
    ],
  },
  {
    key: "home",
    name: "Home & Devices",
    gradient: "linear-gradient(135deg,#1e3a5f,#2563eb)",
    color: "#3b82f6",
    icon: Home,
    apps: [
      { id: "home-assistant", to: "/home-assistant", label: "Home Assistant", description: "Control smart home devices",    gradient: "linear-gradient(135deg,#1c1917,#57534e)", color: "#78716c", icon: Home,    feature: "homeAssistant",  toolId: "homeAssistant" },
      { id: "home-inventory", to: "/home-inventory", label: "Home Inventory", description: "Track devices & appliances",    gradient: "linear-gradient(135deg,#1e3a5f,#2563eb)", color: "#3b82f6", icon: Package, feature: "home-inventory", toolId: "home_inventory" },
      { id: "notes",          to: "/notes",          label: "Notes",          description: "Household knowledge base & personal notes", gradient: "linear-gradient(135deg,#713f12,#ca8a04)", color: "#ca8a04", icon: StickyNote, feature: "notes" },
      { id: "cameras",        to: "/cameras",        label: "Cameras",        description: "Recent camera activity & clips", gradient: "linear-gradient(135deg,#1c1917,#3f3f46)", color: "#a1a1aa", icon: Camera },
      { id: "drop",           to: "/drop",           label: "Drop",           description: "Send files & links between your devices", gradient: "linear-gradient(135deg,#0f172a,#1e3a8a)", color: "#3b82f6", icon: Share2 },
      { id: "routines",       to: "/routines",       label: "Routines",       description: "When this happens, do that",     gradient: "linear-gradient(135deg,#312e81,#6d28d9)", color: "#8b5cf6", icon: Zap },
    ],
  },
  {
    key: "navigation",
    name: "Maps & Weather",
    gradient: "linear-gradient(135deg,#1f4d35,#1d6fa8)",
    color: "#0284c7",
    icon: Compass,
    apps: [
      { id: "maps",       to: "/maps",       label: "Maps",       description: "Offline world maps",                gradient: "linear-gradient(135deg,#163324,#1f4d35)", color: "#16a34a", icon: MapIcon },
      { id: "weather",    to: "/weather",    label: "Weather",    description: "Forecast & alerts",                 gradient: "linear-gradient(135deg,#0c2a52,#1d6fa8)", color: "#0284c7", icon: CloudSun, toolId: "weather" },
      { id: "moon-phase", to: "/moon-phase", label: "Moon Phase", description: "Current phase and lunar calendar",  gradient: "linear-gradient(135deg,#0f172a,#1e293b)", color: "#94a3b8", icon: Moon,     toolId: "moonphase" },
    ],
  },
  {
    key: "utilities",
    name: "Utilities",
    gradient: "linear-gradient(135deg,#166534,#2563eb)",
    color: "#2563eb",
    icon: Settings2,
    apps: [
      { id: "time",           to: "/time",           label: "Time",           description: "World clock, alarms & timers",   gradient: "linear-gradient(135deg,#0f172a,#4338ca)", color: "#6366f1", icon: Clock, toolId: "time" },
      { id: "voice-memos",    to: "/voice-memos",    label: "Voice Memos",    description: "Record & transcribe notes",      gradient: "linear-gradient(135deg,#0c4a6e,#0891b2)", color: "#0891b2", icon: Mic },
      { id: "translate",      to: "/translate",      label: "Translate",      description: "Two-party live translation",     gradient: "linear-gradient(135deg,#0f766e,#0891b2)", color: "#14b8a6", icon: Languages },
      { id: "unit-converter", to: "/unit-converter", label: "Unit Converter", description: "Convert length, weight, and more", gradient: "linear-gradient(135deg,#134e4a,#0d9488)", color: "#0d9488", icon: ArrowLeftRight },
      { id: "converter",      to: "/converter",      label: "File Converter", description: "Convert images, audio & video",  gradient: "linear-gradient(135deg,#166534,#2563eb)", color: "#2563eb", icon: FileType },
      { id: "web-search",     to: "/search",         label: "Search",         description: "Private web search across multiple privacy-respecting engines", gradient: "linear-gradient(135deg,#1e3a5f,#2563eb)", color: "#2563eb", icon: Globe },
      { id: "reverse-lookup", to: "/reverse-lookup", label: "Reverse Lookup", description: "Property & people by address, name, or phone", gradient: "linear-gradient(135deg,#1e3a5f,#2563eb)", color: "#3b82f6", icon: Search },
      { id: "speed-test",     to: "/speed-test",     label: "Speed Test",     description: "Measure your connection speed to the server", gradient: "linear-gradient(135deg,#0c2a52,#0891b2)", color: "#0891b2", icon: Gauge },
    ],
  },
  {
    key: "developer",
    name: "Developer",
    gradient: "linear-gradient(135deg,#0f172a,#1e3a8a)",
    color: "#3b82f6",
    icon: Code2,
    apps: [
      { id: "coding",   to: "/coding",   label: "Coding",   description: "AI coding agent for sandboxed projects", gradient: "linear-gradient(135deg,#0f172a,#1e3a8a)", color: "#3b82f6", icon: Code2, toolId: "coding" },
      { id: "remote",   to: "/remote",   label: "Remote",   description: "SSH, VNC & RDP connections + terminals",   gradient: "linear-gradient(135deg,#0f172a,#334155)", color: "#38bdf8", icon: TerminalSquare },
      { id: "docs-dev", to: "/docs/dev", label: "Dev Docs", description: "Architecture & internals",               gradient: "linear-gradient(135deg,#0f172a,#1e3a8a)", color: "#3b82f6", icon: Code2 },
    ],
  },
];

export function getAppGroup(key: string): AppGroup | undefined {
  return APP_GROUPS.find(g => g.key === key.toLowerCase());
}

/** The generic app-settings route (/apps/:appId/settings/:section?) carries the
 *  app id in the path instead of the app's own route prefix; resolve it so
 *  breadcrumbs/headers keep showing the app there. */
function appIdFromGenericSettingsPath(pathname: string): string | undefined {
  const m = /^\/apps\/([^/]+)\/settings(\/|$)/.exec(pathname);
  return m?.[1];
}

/** Returns the AppItem whose `to` path matches the start of `pathname`. */
export function getAppByPath(pathname: string): AppItem | undefined {
  const settingsAppId = appIdFromGenericSettingsPath(pathname);
  for (const group of APP_GROUPS) {
    for (const app of group.apps) {
      if (settingsAppId ? app.id === settingsAppId : pathname === app.to || pathname.startsWith(app.to + "/")) return app;
    }
  }
  return undefined;
}

/** Returns the AppGroup that contains the app matching `pathname`. */
export function getGroupByAppPath(pathname: string): AppGroup | undefined {
  const settingsAppId = appIdFromGenericSettingsPath(pathname);
  for (const group of APP_GROUPS) {
    if (group.apps.some(a => settingsAppId ? a.id === settingsAppId : pathname === a.to || pathname.startsWith(a.to + "/"))) return group;
  }
  return undefined;
}
