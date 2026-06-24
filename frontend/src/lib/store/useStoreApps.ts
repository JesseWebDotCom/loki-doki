import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Cloud, Search, Calculator, Newspaper, BookOpen, Tv, Clock, Moon,
  Image as ImageIcon, Stethoscope, Play, Calendar, Package, Home, CalendarDays,
  MapPin, Star, Zap, MessageSquare, ShieldCheck, Wrench, type LucideIcon,
} from 'lucide-react'
import type { AppTool } from '@/components/shared/InstallDisclosureModal'
import type { DataSource } from '@/components/shared/ServiceConsentCard'
import { APP_GROUPS, type AppGroup, type AppItem } from '@/lib/appCategories'

/**
 * Unified, enriched app record used across every App Store view. Built by merging
 * the backend tool registry (`GET /api/tools`) with the full-page built-in apps
 * declared in {@link APP_GROUPS}, then resolving consistent visuals + category.
 */
export interface StoreApp {
  id: string
  name: string
  description: string
  /** Display label for the category, e.g. "AI". */
  category: string
  /** STORE_CATEGORIES key for routing/filtering, e.g. "ai". */
  categoryKey: string
  icon: LucideIcon
  /** CSS linear-gradient backdrop (preferred). */
  gradient?: string
  /** Tailwind `from-… to-…` fallback when no CSS gradient is known. */
  colorClass?: string
  /** Solid accent colour (hex or css var) for tints. */
  accent: string
  /** true = chat-only Extension; false = full App with a page. */
  offline: boolean
  /** Installed / enabled. */
  enabled: boolean
  /** Built-in app with no enable toggle. */
  builtIn: boolean
  /** Connects to external services. */
  online: boolean
  /** Destination page route, if any. */
  route?: string
  dataSources: DataSource[]
  examples: string[]
}

/** Store category — reuses the app catalog groups for nav/visuals. */
export interface StoreCategory {
  key: string
  name: string
  icon: LucideIcon
  gradient: string
  color: string
}

export const STORE_CATEGORIES: StoreCategory[] = APP_GROUPS.map(g => ({
  key: g.key,
  name: g.name,
  icon: g.icon,
  gradient: g.gradient,
  color: g.color,
}))

const DEFAULT_CATEGORY: StoreCategory =
  STORE_CATEGORIES.find(c => c.key === 'tools') ?? STORE_CATEGORIES[0]

// ── Tool → route map (extensions have no page) ─────────────────────────────────
export const TOOL_ROUTES: Record<string, string> = {
  weather:          '/weather',
  news:             '/news',
  recipes:          '/recipes',
  dictionary:       '/dictionary',
  youtube:          '/youtube',
  tvshows:          '/shows',
  image_gen:        '/imaging',
  medical:          '/medical',
  'where-to-watch': '/where-to-watch',
  holidays:         '/holidays',
  home_inventory:   '/home-inventory',
  onthisday:        '/on-this-day',
  localEvents:      '/local-events',
  localNews:        '/news',
  sports:           '/sports',
  homeAssistant:    '/home-assistant',
  moonphase:        '/moon-phase',
  jokes:            '/jokes',
  unit_conversion:  '/unit-converter',
  time:             '/time',
}

// ── Fallback meta for tools not represented in APP_GROUPS ──────────────────────
interface FallbackMeta { icon: LucideIcon; colorClass: string; category: string }
const APP_META: Record<string, FallbackMeta> = {
  weather:          { icon: Cloud,       colorClass: 'from-sky-400 to-blue-600',      category: 'Navigation'   },
  search:           { icon: Search,      colorClass: 'from-violet-400 to-purple-600', category: 'Tools'        },
  calculator:       { icon: Calculator,  colorClass: 'from-orange-400 to-amber-600',  category: 'Tools'        },
  unit_conversion:  { icon: Wrench,      colorClass: 'from-slate-400 to-slate-600',   category: 'Tools'        },
  jokes:            { icon: Star,        colorClass: 'from-yellow-400 to-orange-500', category: 'Entertainment'},
  news:             { icon: Newspaper,   colorClass: 'from-red-500 to-rose-600',      category: 'Today'        },
  recipes:          { icon: BookOpen,    colorClass: 'from-emerald-400 to-green-600', category: 'Entertainment'},
  dictionary:       { icon: BookOpen,    colorClass: 'from-teal-400 to-cyan-600',     category: 'Knowledge'    },
  youtube:          { icon: Play,        colorClass: 'from-red-600 to-red-700',       category: 'Entertainment'},
  tvshows:          { icon: Tv,          colorClass: 'from-purple-400 to-indigo-600', category: 'Entertainment'},
  datetime:         { icon: Clock,       colorClass: 'from-blue-400 to-indigo-600',   category: 'Tools'        },
  moonphase:        { icon: Moon,        colorClass: 'from-slate-500 to-slate-800',   category: 'Today'        },
  image_gen:        { icon: ImageIcon,   colorClass: 'from-pink-400 to-fuchsia-600',  category: 'AI'           },
  medical:          { icon: Stethoscope, colorClass: 'from-green-400 to-emerald-600', category: 'Knowledge'    },
  'where-to-watch': { icon: Play,        colorClass: 'from-amber-400 to-orange-600',  category: 'Entertainment'},
  holidays:         { icon: Calendar,    colorClass: 'from-red-400 to-pink-500',      category: 'Today'        },
  home_inventory:   { icon: Home,        colorClass: 'from-cyan-400 to-blue-600',     category: 'Tools'        },
  onthisday:        { icon: CalendarDays,colorClass: 'from-amber-500 to-yellow-600',  category: 'Today'        },
  localEvents:      { icon: MapPin,      colorClass: 'from-lime-400 to-green-600',     category: 'Today'        },
  localNews:        { icon: Newspaper,   colorClass: 'from-rose-400 to-red-600',      category: 'Today'        },
  contentRating:    { icon: ShieldCheck, colorClass: 'from-slate-400 to-slate-600',   category: 'Tools'        },
  sports:           { icon: Zap,         colorClass: 'from-green-400 to-teal-600',     category: 'Today'        },
  homeAssistant:    { icon: Package,     colorClass: 'from-blue-500 to-indigo-700',   category: 'Tools'        },
}

// ── Lookups from APP_GROUPS (by app id, toolId, and route) ─────────────────────
interface CatalogEntry { item: AppItem; group: AppGroup }
const byId: Record<string, CatalogEntry> = {}
const byRoute: Record<string, CatalogEntry> = {}
for (const group of APP_GROUPS) {
  for (const item of group.apps) {
    const entry = { item, group }
    byId[item.id] = entry
    if (item.toolId) byId[item.toolId] = entry
    byRoute[item.to] = entry
  }
}

function resolveCatalog(id: string, route?: string): CatalogEntry | undefined {
  return byId[id] ?? (route ? byRoute[route] : undefined)
}

function categoryByName(name: string): StoreCategory {
  return STORE_CATEGORIES.find(c => c.name === name) ?? DEFAULT_CATEGORY
}

/** Build the enriched record for a single backend tool. */
function fromTool(tool: AppTool): StoreApp {
  const route = TOOL_ROUTES[tool.id]
  const catalog = resolveCatalog(tool.id, route)
  const fallback = APP_META[tool.id]
  const category = catalog
    ? catalog.group
    : categoryByName(fallback?.category ?? DEFAULT_CATEGORY.name)
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: category.name,
    categoryKey: category.key,
    icon: catalog?.item.icon ?? fallback?.icon ?? MessageSquare,
    gradient: catalog?.item.gradient,
    colorClass: catalog ? undefined : (fallback?.colorClass ?? 'from-brand to-brand/60'),
    accent: catalog?.item.color ?? category.color,
    offline: tool.offline,
    enabled: tool.enabled,
    builtIn: false,
    online: (tool.dataSources?.length ?? 0) > 0,
    route,
    dataSources: tool.dataSources ?? [],
    examples: (tool as AppTool & { examples?: string[] }).examples ?? [],
  }
}

/** Build the enriched record for a full-page built-in app (no backend tool). */
function fromBuiltin(item: AppItem, group: AppGroup): StoreApp {
  return {
    id: item.id,
    name: item.label,
    description: item.description,
    category: group.name,
    categoryKey: group.key,
    icon: item.icon,
    gradient: item.gradient,
    accent: item.color,
    offline: false,
    enabled: true,
    builtIn: true,
    online: false,
    route: item.to,
    dataSources: [],
    examples: [],
  }
}

async function fetchTools(): Promise<AppTool[]> {
  const res = await fetch('/api/tools', { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to load apps')
  return res.json() as Promise<AppTool[]>
}

/** Merge backend tools with built-in app pages, deduped by destination route. */
function mergeApps(apiTools: AppTool[]): StoreApp[] {
  const fromTools = apiTools.map(fromTool)
  const taken = new Set(fromTools.map(t => t.route).filter(Boolean))
  const extras: StoreApp[] = []
  for (const group of APP_GROUPS) {
    for (const item of group.apps) {
      if (item.toolId) continue          // tool-backed apps already come from /api/tools
      if (taken.has(item.to)) continue   // route already represented
      extras.push(fromBuiltin(item, group))
    }
  }
  return [...fromTools, ...extras]
}

export interface UseStoreApps {
  apps: StoreApp[]
  isLoading: boolean
  installedCount: number
  getApp: (id: string) => StoreApp | undefined
  byCategory: (key: string) => StoreApp[]
}

export function useStoreApps(): UseStoreApps {
  const { data: apiTools = [], isLoading } = useQuery<AppTool[]>({
    queryKey: ['tools'],
    queryFn: fetchTools,
  })

  const apps = useMemo(() => mergeApps(apiTools), [apiTools])

  return useMemo(() => ({
    apps,
    isLoading,
    installedCount: apps.filter(a => a.enabled).length,
    getApp: (id: string) => apps.find(a => a.id === id),
    byCategory: (key: string) => apps.filter(a => a.categoryKey === key),
  }), [apps, isLoading])
}

/** Count of apps per category key (for category index cards). */
export function categoryCounts(apps: StoreApp[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const a of apps) counts[a.categoryKey] = (counts[a.categoryKey] ?? 0) + 1
  return counts
}
