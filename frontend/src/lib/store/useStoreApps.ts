import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Search, Calculator, Newspaper, BookOpen, Clock,
  Image as ImageIcon, Stethoscope,
  MessageSquare, ShieldCheck, Wrench, type LucideIcon,
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
  /** Works fully locally without internet (backend tool.offline flag). */
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
  /** Extra lowercase search terms so natural words find the app (e.g. "shop" → Price Tracker). */
  keywords?: string[]
  /** Owning user feature: install/remove goes through /api/features/:featureId. */
  featureId?: string | null
}

/** Store category - reuses the app catalog groups for nav/visuals. */
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
  STORE_CATEGORIES.find(c => c.key === 'utilities') ?? STORE_CATEGORIES[0]

// ── Tool → route map (extensions have no page) ─────────────────────────────────
export const TOOL_ROUTES: Record<string, string> = {
  weather:          '/weather',
  news:             '/news',
  recipes:          '/recipes',
  youtube:          '/videos',
  tvshows:          '/shows',
  image_gen:        '/imaging',
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
  shopping:         '/shopping',
}

// ── Fallback meta for tools genuinely NOT represented in APP_GROUPS ────────────
// Entries here must be tools with no matching AppItem (by id or toolId): anything
// with a catalog match already resolves its icon/gradient from there (see fromTool()
// below: `catalog?.item.icon ?? fallback?.icon`), so a duplicate entry here is dead
// code that silently drifts from the real one (this list used to carry a stale
// `youtube: { icon: Play, colorClass: 'from-destructive...' }` entry from when the app
// was YouTube-red, long after the app itself moved to the Videos hub's own identity;
// the catalog always won, so nobody noticed until this comment did.
// colorClass gradients stay on design tokens (nearest semantic hue family) so
// fallback icon tiles never reintroduce the raw Tailwind palette.
interface FallbackMeta { icon: LucideIcon; colorClass: string; category: string }
const APP_META: Record<string, FallbackMeta> = {
  search:           { icon: Search,      colorClass: 'from-brand to-brand/60',                       category: 'Utilities'           },
  calculator:       { icon: Calculator,  colorClass: 'from-warning to-warning/60',                   category: 'Utilities'           },
  unit_conversion:  { icon: Wrench,      colorClass: 'from-muted-foreground to-muted-foreground/60', category: 'Utilities'           },
  dictionary:       { icon: BookOpen,    colorClass: 'from-info to-info/60',                         category: 'Reading & Reference' },
  datetime:         { icon: Clock,       colorClass: 'from-info to-info/60',                         category: 'Utilities'           },
  image_gen:        { icon: ImageIcon,   colorClass: 'from-brand to-brand/60',                       category: 'Creativity'          },
  medical:          { icon: Stethoscope, colorClass: 'from-success to-success/60',                   category: 'Reading & Reference' },
  localNews:        { icon: Newspaper,   colorClass: 'from-destructive to-destructive/60',           category: 'News & Sports'       },
  contentRating:    { icon: ShieldCheck, colorClass: 'from-muted-foreground to-muted-foreground/60', category: 'Utilities'           },
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

const STOP_WORDS = new Set(['this', 'that', 'the', 'a', 'an', 'my', 'me', 'for', 'is', 'on', 'of', 'to', 'any', 'what', 's', 'i', 'im', 'are', 'do', 'get', 'you'])

/** Lowercase content words pulled from a tool's example prompts, for search matching. */
function keywordsFromExamples(examples: string[]): string[] {
  const words = new Set<string>()
  for (const ex of examples) {
    for (const w of ex.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
      if (w.length > 2 && !STOP_WORDS.has(w)) words.add(w)
    }
  }
  return [...words]
}

/** Build the enriched record for a single backend tool. */
function fromTool(tool: AppTool): StoreApp {
  // A tool that backs a catalog app (byId matches item.id or item.toolId)
  // inherits that app's page route even without a TOOL_ROUTES entry, e.g.
  // maps/canvas/coding/showtimes. Otherwise the page would be lost, since
  // mergeApps skips the builtin as "already represented" by this tool.
  const route = TOOL_ROUTES[tool.id] ?? byId[tool.id]?.item.to
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
    keywords: keywordsFromExamples((tool as AppTool & { examples?: string[] }).examples ?? []),
    featureId: tool.featureId ?? null,
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

/** Merge backend tools with built-in app pages, deduped by destination route and id.
 *  The store is Apps-only: tools without a page route (chat-only companion
 *  abilities + core plumbing) are excluded - abilities surface as toggles in
 *  each app's settings page instead. */
function mergeApps(apiTools: AppTool[]): StoreApp[] {
  const fromTools = apiTools
    .filter(t => !t.core && (TOOL_ROUTES[t.id] ?? byId[t.id]?.item.to))
    .map(fromTool)
  const taken = new Set(fromTools.map(t => t.route).filter(Boolean))
  // Belt-and-suspenders id dedup: route-based dedup above only catches builtins
  // pointing at a route a tool already covers. Two builtin entries across different
  // APP_GROUPS could still share an id (a registry data collision), which route
  // dedup wouldn't catch, and React needs a unique id/key regardless of the cause.
  const seenIds = new Set(fromTools.map(t => t.id))
  const extras: StoreApp[] = []
  for (const group of APP_GROUPS) {
    for (const item of group.apps) {
      if (item.toolId) continue          // tool-backed apps already come from /api/tools
      if (taken.has(item.to)) continue   // route already represented
      if (seenIds.has(item.id)) continue // id already represented
      seenIds.add(item.id)
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
