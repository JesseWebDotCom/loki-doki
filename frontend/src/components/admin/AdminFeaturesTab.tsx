import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useAuth } from '@/context/AuthContext'
import {
  ArrowLeftRight, ArrowRight, BookOpen, Bot, Calculator, CalendarClock, ChefHat, CheckCircle2,
  ChevronDown, Clock, Cloud, Database, Download, Ear, Eraser, Eye, EyeOff, Film, Globe,
  Home, Laugh, Lightbulb, Loader2, Map as MapIcon, MapPin, MessageSquare, Mic, Moon, Newspaper, Package,
  PartyPopper, Play, RefreshCw, Route, ScanFace, Search, Server, Settings2, ShieldCheck, Sparkles,
  Stethoscope, Trash2, Trophy, Tv, Wand2, Wifi, Wrench, X, Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/cn'
import { formatFeatureBytes } from '@/lib/features'
import { DownloadProgress } from '@/components/shared/DownloadProgress'
import type { DownloadStatus } from '@/components/shared/DownloadProgress'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { AdminHomeAssistantSection } from '@/components/admin/AdminHomeAssistantSection'
import { AdminYoutubeLimitsSection } from '@/components/admin/AdminYoutubeLimitsSection'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InstallState {
  status: DownloadStatus
  completed: number
  total: number
  speedBps: number
  etaSeconds: number
  statusMessage?: string
  error?: string
}

interface ConfigField {
  key: string
  label: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'secret'
  scope: 'global' | 'user' | 'both'
  placeholder?: string
}

interface ToolInfo {
  id: string
  name: string
  description: string
  offline: boolean
  core: boolean
  examples: string[]
  configSchema: ConfigField[]
  enabled: boolean
}

interface ToolUser {
  id: string
  firstName: string
  nickname: string
  role: 'admin' | 'user'
}

type GlobalConfig = Record<string, Record<string, unknown>>
type Permissions  = Record<string, Record<string, 'allow' | 'deny'>>

// ── Tool icons + categories ───────────────────────────────────────────────────

const TOOL_CATEGORY_ORDER = ['Information', 'Utilities', 'Lifestyle', 'Media', 'Creative'] as const
type ToolCategory = (typeof TOOL_CATEGORY_ORDER)[number]

const TOOL_ICONS: Record<string, { icon: LucideIcon; chip: string; category: ToolCategory }> = {
  weather:         { icon: Cloud,          chip: 'bg-sky-500/15 text-sky-500',         category: 'Information' },
  search:          { icon: Globe,          chip: 'bg-blue-500/15 text-blue-500',        category: 'Information' },
  news:            { icon: Newspaper,      chip: 'bg-orange-500/15 text-orange-500',    category: 'Information' },
  dictionary:      { icon: BookOpen,       chip: 'bg-amber-500/15 text-amber-500',      category: 'Information' },
  calculator:      { icon: Calculator,     chip: 'bg-brand/15 text-brand',              category: 'Utilities'   },
  unit_conversion: { icon: ArrowLeftRight, chip: 'bg-teal-500/15 text-teal-500',        category: 'Utilities'   },
  jokes:           { icon: Laugh,          chip: 'bg-yellow-500/15 text-yellow-500',    category: 'Lifestyle'   },
  recipes:         { icon: ChefHat,        chip: 'bg-emerald-500/15 text-emerald-500',  category: 'Lifestyle'   },
  youtube:         { icon: Play,           chip: 'bg-red-500/15 text-red-500',          category: 'Media'       },
  tvshows:         { icon: Tv,             chip: 'bg-purple-500/15 text-purple-500',    category: 'Media'       },
  onthisday:       { icon: CalendarClock,  chip: 'bg-indigo-500/15 text-indigo-500',    category: 'Information' },
  localNews:       { icon: Newspaper,      chip: 'bg-rose-500/15 text-rose-500',        category: 'Information' },
  localEvents:     { icon: MapPin,         chip: 'bg-green-500/15 text-green-500',      category: 'Lifestyle'   },
  contentRating:   { icon: ShieldCheck,    chip: 'bg-amber-500/15 text-amber-500',      category: 'Media'       },
  sports:          { icon: Trophy,         chip: 'bg-yellow-500/15 text-yellow-600',    category: 'Information' },
  datetime:        { icon: Clock,          chip: 'bg-slate-500/15 text-slate-400',      category: 'Information' },
  moonphase:       { icon: Moon,           chip: 'bg-indigo-500/15 text-indigo-400',    category: 'Information' },
  medical:         { icon: Stethoscope,    chip: 'bg-red-500/15 text-red-500',          category: 'Lifestyle'   },
  holidays:        { icon: PartyPopper,    chip: 'bg-pink-500/15 text-pink-500',        category: 'Lifestyle'   },
  home_inventory:  { icon: Package,        chip: 'bg-orange-500/15 text-orange-500',    category: 'Lifestyle'   },
  homeAssistant:   { icon: Lightbulb,      chip: 'bg-amber-500/15 text-amber-500',      category: 'Lifestyle'   },
  'where-to-watch':{ icon: Film,           chip: 'bg-violet-500/15 text-violet-500',    category: 'Media'       },
  image_gen:       { icon: ImageIcon,      chip: 'bg-fuchsia-500/15 text-fuchsia-500',  category: 'Creative'    },
}

// ── Toggle switch ─────────────────────────────────────────────────────────────

function ToggleSwitch({ checked, disabled, onChange }: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative shrink-0 h-5 w-9 rounded-full transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
        checked ? 'bg-brand' : 'bg-foreground/15',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className={cn(
        'absolute top-[2px] size-4 rounded-full bg-white shadow-sm transition-transform duration-200',
        checked ? 'left-[18px]' : 'left-[2px]',
      )} />
    </button>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function qMatch(text: string, q: string): boolean {
  return text.toLowerCase().includes(q.toLowerCase())
}

// ── Catalog types (mirrors SetupWizard) ──────────────────────────────────────

type ModelRole =
  | 'llm' | 'uncensored_llm' | 'vision' | 'embeddings' | 'router' | 'router_llm'
  | 'image_gen' | 'face_id' | 'face_embed' | 'video_motion' | 'video_gen' | 'bg_remove'
  | 'voice' | 'runtime' | 'component'

interface CatalogEntry {
  id: string; role: ModelRole; label: string; description: string
  backend: 'ollama' | 'huggingface' | 'url'; approxBytes: number; tags: string[]
  format?: string; backendLabel?: string; required?: boolean; installed: boolean
  recommended: boolean; tiers: string[]; builtinVision?: boolean
  linkedWith?: string[]; requires?: string[]
}

interface CatalogTier { id: string; label: string; detail: string }

interface FullCatalogResponse {
  hardware: { totalRamGb: number; isAppleSilicon: boolean; platform: string }
  recommendedTier: string; tiers: CatalogTier[]; models: CatalogEntry[]
  disk: { freeBytes: number; totalBytes: number }; ollamaRunning: boolean
  ollamaInstallBytes: number; activeModelIds: Record<string, string | null>
}

interface AdminCapDef {
  id: string; label: string; description: string; bytes: number
  requires: string[]; base?: boolean; icon: ComponentType<{ className?: string }>
}

// ── Constants (direct copy from SetupWizard) ─────────────────────────────────

const ADMIN_CAPS: AdminCapDef[] = [
  { id: 'tesseract',     label: 'Home Inventory', description: 'Snap a photo — AI identifies your devices and tracks warranties (Tesseract OCR)', bytes: 30_000_000,  requires: [],            base: true, icon: Home },
  { id: 'searxng',       label: 'Web Search',      description: 'Local SearXNG metasearch — aggregates Google/Brave/Startpage so web search works where direct scraping is blocked. Auto-updates weekly. Source: github.com/searxng/searxng (AGPL-3.0)', bytes: 300_000_000, requires: [],            icon: Globe },
  { id: 'voice-core',   label: 'Voice',           description: 'Read replies aloud and speak to your AI (Kokoro + Whisper)',                       bytes: 320_000_000, requires: [],                       icon: Mic  },
  { id: 'wakeword-core', label: 'Wake Word',       description: 'Hands-free "Hey Jarvis" activation',                                               bytes: 6_000_000,  requires: ['voice-core'],            icon: Ear  },
]

const LLM_ROLES_SET = new Set<ModelRole>(['llm', 'uncensored_llm'])
const CHAT_ROLES_SET = new Set<ModelRole>(['vision', 'embeddings', 'router', 'router_llm'])
const IMAGE_GEN_ROLES_SET = new Set<ModelRole>(['image_gen', 'face_id', 'video_motion', 'bg_remove'])

const MODEL_ROLE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  runtime: Server, llm: Bot, uncensored_llm: Bot, vision: Eye, embeddings: Database,
  router: Route, router_llm: Route, image_gen: Wand2, face_id: ScanFace,
  video_motion: Film, bg_remove: Eraser, voice: Mic, component: Package,
}

const MODEL_ROLE_LABELS: Record<string, string> = {
  llm: 'Language Model', uncensored_llm: 'Uncensored Model', vision: 'Vision Model',
  embeddings: 'Embedding Model', router: 'Tool Router', router_llm: 'Router LLM',
  image_gen: 'Image Generator', face_id: 'Face Identity', video_motion: 'Video Generation',
  bg_remove: 'Background Removal', voice: 'Voice Model', runtime: 'Runtime',
}

function fmtCatalogBytes(b: number): string {
  if (b <= 0) return '-'
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${(b / 1_073_741_824).toFixed(1)} GB`
}

// ── ModelInstallRow ───────────────────────────────────────────────────────────

function ModelInstallRow({ entry, isActive, installState, onInstall, onCancel, allEntries, onSwap, blocked }: {
  entry: CatalogEntry
  isActive?: boolean
  installState?: InstallState
  onInstall: () => void
  onCancel: () => void
  allEntries?: CatalogEntry[]
  onSwap?: (e: CatalogEntry) => void
  blocked?: boolean
}) {
  const [showDetails, setShowDetails] = useState(false)
  const [showChange, setShowChange] = useState(false)
  const RoleIcon = (MODEL_ROLE_ICONS[entry.role] ?? Package) as ComponentType<{ className?: string }>
  const isInstalling = installState?.status === 'downloading'
  const isDone = installState?.status === 'completed'
  const isInstalled = (entry.installed || isDone) && !isInstalling
  const hasAlts = (allEntries?.length ?? 0) > 1

  return (
    <div className={cn('rounded-xl border bg-card transition-colors', blocked && 'opacity-50 pointer-events-none',
      isInstalled ? 'border-violet-500/20' : 'border-border')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={cn('flex size-5 shrink-0 items-center justify-center rounded-full',
          isInstalled ? 'bg-emerald-500/15' : 'bg-muted')}>
          {isInstalling
            ? <Loader2 className="size-3 animate-spin text-muted-foreground" />
            : isInstalled
            ? <CheckCircle2 className="size-3 text-emerald-400" />
            : <div className="size-1.5 rounded-full bg-muted-foreground/30" />}
        </div>
        <RoleIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
              {MODEL_ROLE_LABELS[entry.role] ?? entry.role}
            </span>
            {isActive && <span className="text-[10px] font-semibold text-emerald-400 shrink-0">Active</span>}
            {entry.required && !LLM_ROLES_SET.has(entry.role) && (
              <span className="text-[10px] font-semibold text-violet-400 shrink-0">Required</span>
            )}
            {hasAlts && !isActive && !LLM_ROLES_SET.has(entry.role) && (
              <span className="text-[10px] font-semibold text-violet-400 shrink-0">Choose one</span>
            )}
          </div>
          <p className="text-sm font-semibold leading-tight truncate">{entry.label}</p>
        </div>
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">~{fmtCatalogBytes(entry.approxBytes)}</span>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => { setShowDetails(v => !v); setShowChange(false) }}
            className={cn('flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs transition-colors',
              showDetails ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5')}>
            details <ChevronDown className={cn('size-3 transition-transform', showDetails && 'rotate-180')} />
          </button>
          {hasAlts && (
            <button type="button" onClick={() => { setShowChange(v => !v); setShowDetails(false) }}
              className={cn('rounded-lg px-2 py-1 text-xs transition-colors',
                showChange ? 'bg-violet-500/20 text-violet-300' : 'text-muted-foreground hover:text-violet-300 hover:bg-violet-500/10')}>
              change
            </button>
          )}
          {isInstalling ? (
            <button type="button" onClick={onCancel}
              className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">
              Cancel
            </button>
          ) : isInstalled ? (
            <span className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-emerald-400 bg-emerald-500/8">
              <CheckCircle2 className="size-2.5" /> {isActive ? 'Active' : 'Installed'}
            </span>
          ) : (
            <button type="button" onClick={onInstall}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-violet-500/40 hover:bg-violet-500/5 transition-colors">
              <Download className="size-3" /> Install
            </button>
          )}
        </div>
      </div>

      {showDetails && (
        <div className="border-t border-border/50 px-4 py-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
          <p className="text-xs text-muted-foreground leading-relaxed">{entry.description}</p>
          <div className="flex flex-wrap gap-1.5">
            {entry.format && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{entry.format}</span>}
            {entry.backendLabel && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{entry.backendLabel}</span>}
            {entry.tags.map(tag => <span key={tag} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{tag}</span>)}
          </div>
        </div>
      )}

      {showChange && allEntries && onSwap && (
        <div className="border-t border-border/50 px-4 py-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Choose model</p>
          {allEntries.map(alt => (
            <button key={alt.id} type="button" onClick={() => { onSwap(alt); setShowChange(false) }}
              className={cn('w-full rounded-lg border px-3 py-2.5 text-left transition-all',
                alt.id === entry.id ? 'border-violet-500/40 bg-violet-500/8' : 'border-border bg-background/50 hover:border-border/80 hover:bg-accent/30')}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{alt.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{alt.description}</p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="text-xs tabular-nums text-muted-foreground">~{fmtCatalogBytes(alt.approxBytes)}</span>
                  {alt.installed && <CheckCircle2 className="size-3.5 text-emerald-400" />}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {installState && installState.status !== 'idle' && (
        <div className="border-t border-border/50 px-4 pb-3 pt-2">
          <DownloadProgress
            label={entry.label}
            description={installState.statusMessage}
            status={installState.status}
            progress={installState.total > 0 ? Math.round((installState.completed / installState.total) * 100) : undefined}
            downloadedBytes={installState.completed}
            totalBytes={installState.total}
            speedBps={installState.speedBps}
            etaSeconds={installState.etaSeconds}
            error={installState.error}
          />
        </div>
      )}
    </div>
  )
}

// ── CapInstallRow ─────────────────────────────────────────────────────────────

function CapInstallRow({ cap, installed, blocked, installState, onInstall, onCancel }: {
  cap: AdminCapDef; installed: boolean; blocked?: boolean
  installState?: InstallState; onInstall: () => void; onCancel: () => void
}) {
  const Icon = cap.icon
  const isInstalling = installState?.status === 'downloading'
  const isDone = installState?.status === 'completed'
  const isInstalled = (installed || isDone) && !isInstalling

  return (
    <div className={cn('rounded-xl border bg-card transition-colors', blocked && 'opacity-50 pointer-events-none',
      isInstalled ? 'border-violet-500/20' : 'border-border')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={cn('flex size-5 shrink-0 items-center justify-center rounded-full',
          isInstalled ? 'bg-emerald-500/15' : 'bg-muted')}>
          {isInstalling
            ? <Loader2 className="size-3 animate-spin text-muted-foreground" />
            : isInstalled
            ? <CheckCircle2 className="size-3 text-emerald-400" />
            : <div className="size-1.5 rounded-full bg-muted-foreground/30" />}
        </div>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight">{cap.label}</p>
          <p className="text-xs text-muted-foreground leading-tight truncate">{cap.description}</p>
        </div>
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">~{fmtCatalogBytes(cap.bytes)}</span>
        <div className="shrink-0">
          {isInstalling ? (
            <button type="button" onClick={onCancel}
              className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">
              Cancel
            </button>
          ) : isInstalled ? (
            <span className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-emerald-400 bg-emerald-500/8">
              <CheckCircle2 className="size-2.5" /> Installed
            </span>
          ) : (
            <button type="button" onClick={onInstall}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-violet-500/40 hover:bg-violet-500/5 transition-colors disabled:opacity-50 disabled:pointer-events-none">
              <Download className="size-3" /> Install
            </button>
          )}
        </div>
      </div>
      {installState && installState.status !== 'idle' && (
        <div className="border-t border-border/50 px-4 pb-3 pt-2">
          <DownloadProgress
            label={cap.label}
            description={installState.statusMessage}
            status={installState.status}
            progress={installState.total > 0 ? Math.round((installState.completed / installState.total) * 100) : undefined}
            downloadedBytes={installState.completed}
            totalBytes={installState.total}
            speedBps={installState.speedBps}
            etaSeconds={installState.etaSeconds}
            error={installState.error}
          />
        </div>
      )}
    </div>
  )
}

// ── ZIM archive section ───────────────────────────────────────────────────────

interface ZimVariant { key: string; label: string; approxBytes: number; description: string }
interface ZimEntry {
  sourceId: string; label: string; description: string; category: string
  faviconUrl: string | null; variants: ZimVariant[]; defaultVariant: string
  variantKey: string; installed: boolean; fileSizeBytes: number | null
}
interface ZimDlState {
  status: 'downloading' | 'done' | 'error' | 'cancelled'
  completed: number; total: number; speedBps: number; etaSeconds: number
  statusMsg: string; error: string | null
}

const ZIM_CATEGORY_ORDER = [
  'Reference', 'Education', 'How-To', 'Development', 'Books',
  'Medical', 'Science', 'Survival', 'Entertainment', 'Kids', 'Religion',
]

function ZimSection({ kiwixInstalled, query }: { kiwixInstalled: boolean; query: string }) {
  const [catalog, setCatalog]               = useState<ZimEntry[]>([])
  const [loading, setLoading]               = useState(true)
  const [downloads, setDownloads]           = useState<Map<string, ZimDlState>>(new Map())
  const [variants, setVariants]             = useState<Map<string, string>>(new Map())
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set(ZIM_CATEGORY_ORDER))
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const esRefs = useRef<Map<string, EventSource>>(new Map())

  const loadCatalog = useCallback(() => {
    setLoading(true)
    fetch('/api/admin/archives/catalog', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { catalog?: ZimEntry[] }) => setCatalog(d.catalog ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadCatalog() }, [loadCatalog])

  // Close any open SSE downloads on unmount so navigating away mid-download
  // doesn't leak connections or fire setState after the component is gone.
  useEffect(() => () => { for (const es of esRefs.current.values()) es.close() }, [])

  function getVariant(entry: ZimEntry) { return variants.get(entry.sourceId) ?? entry.variantKey }

  function toDlStatus(s: ZimDlState | undefined): DownloadStatus {
    if (!s) return 'idle'
    if (s.status === 'downloading') return s.total > 0 ? 'downloading' : 'pending'
    if (s.status === 'done') return 'completed'
    if (s.status === 'error') return 'error'
    return 'cancelled'
  }

  function setDl(sourceId: string, patch: Partial<ZimDlState>) {
    setDownloads(prev => {
      const next = new Map(prev)
      const cur = next.get(sourceId) ?? { status: 'downloading' as const, completed: 0, total: 0, speedBps: 0, etaSeconds: 0, statusMsg: '', error: null }
      next.set(sourceId, { ...cur, ...patch })
      return next
    })
  }

  function handleDownload(sourceId: string, variantKey: string) {
    fetch(`/api/admin/archives/cancel/${sourceId}`, { method: 'POST', credentials: 'include' }).catch(() => {})
    esRefs.current.get(sourceId)?.close()
    setDl(sourceId, { status: 'downloading', completed: 0, total: 0, speedBps: 0, etaSeconds: 0, statusMsg: 'Starting…', error: null })
    const es = new EventSource(`/api/admin/archives/download/${sourceId}?variantKey=${encodeURIComponent(variantKey)}`, { withCredentials: true })
    esRefs.current.set(sourceId, es)
    let closed = false
    const cleanup = () => { if (!closed) { closed = true; es.close(); esRefs.current.delete(sourceId) } }
    es.addEventListener('status', (e) => { try { const { msg } = JSON.parse((e as MessageEvent).data) as { msg: string }; setDl(sourceId, { statusMsg: msg }) } catch { /* malformed frame */ } })
    es.addEventListener('progress', (e) => { try { const p = JSON.parse((e as MessageEvent).data) as { completed: number; total: number; speedBps: number; etaSeconds: number }; setDl(sourceId, { ...p, status: 'downloading' }) } catch { /* malformed frame */ } })
    es.addEventListener('done', () => { cleanup(); setDl(sourceId, { status: 'done' }); loadCatalog() })
    es.addEventListener('cancelled', () => { cleanup(); setDl(sourceId, { status: 'cancelled' }) })
    es.addEventListener('error', (e) => {
      cleanup()
      const msg = 'data' in e ? (() => { try { return (JSON.parse((e as MessageEvent).data) as { msg: string }).msg } catch { return 'Download failed' } })() : 'Connection lost'
      setDl(sourceId, { status: 'error', error: msg })
    })
  }

  function handleCancel(sourceId: string) {
    esRefs.current.get(sourceId)?.close()
    fetch(`/api/admin/archives/cancel/${sourceId}`, { method: 'POST', credentials: 'include' })
    setDl(sourceId, { status: 'cancelled' })
  }

  async function handleDelete(sourceId: string) {
    await fetch(`/api/admin/archives/${sourceId}`, { method: 'DELETE', credentials: 'include' })
    loadCatalog()
  }

  function handleDownloadAll(entries: ZimEntry[]) {
    for (const entry of entries) {
      const dl = downloads.get(entry.sourceId)
      if (!entry.installed && dl?.status !== 'downloading') handleDownload(entry.sourceId, getVariant(entry))
    }
  }

  function toggleCategory(cat: string) {
    setOpenCategories(prev => { const next = new Set(prev); if (next.has(cat)) next.delete(cat); else next.add(cat); return next })
  }

  const displayCatalog = query
    ? catalog.filter(e => qMatch(e.label, query) || qMatch(e.description, query) || qMatch(e.category, query))
    : catalog

  const categorized = useMemo(() => {
    const groups = new Map<string, ZimEntry[]>()
    for (const entry of displayCatalog) {
      const cat = entry.category || 'Other'
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(entry)
    }
    return groups
  }, [displayCatalog])

  const notInstalled = displayCatalog.filter(e => !e.installed && downloads.get(e.sourceId)?.status !== 'downloading')
  if (query && displayCatalog.length === 0) return null

  return (
    <div className={cn('space-y-3', !kiwixInstalled && 'opacity-40 pointer-events-none')}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">Content Packs</span>
        {notInstalled.length > 0 && kiwixInstalled && (
          <button type="button" onClick={() => handleDownloadAll(notInstalled)}
            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">
            <Download className="size-3" /> Add all
          </button>
        )}
      </div>

      {kiwixInstalled && (
        loading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="size-3 animate-spin text-muted-foreground/40" />
            <span className="text-xs text-muted-foreground/40">Loading…</span>
          </div>
        ) : (
          <div className="space-y-3">
            {ZIM_CATEGORY_ORDER.filter(cat => categorized.has(cat)).map(cat => {
              const entries = categorized.get(cat)!
              const catInstalled = entries.filter(e => e.installed || toDlStatus(downloads.get(e.sourceId)) === 'completed').length
              const catNotInstalled = entries.filter(e => !e.installed && downloads.get(e.sourceId)?.status !== 'downloading')
              const catOpen = query ? true : openCategories.has(cat)

              return (
                <div key={cat}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <button type="button" onClick={() => !query && toggleCategory(cat)}
                      className="flex items-center gap-2 flex-1 min-w-0">
                      <ChevronDown className={cn('size-3 text-muted-foreground/40 transition-transform', !catOpen && '-rotate-90')} />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">{cat}</span>
                      <span className="text-[10px] text-muted-foreground/35 tabular-nums">{catInstalled}/{entries.length}</span>
                    </button>
                    {catNotInstalled.length > 0 && (
                      <button type="button" onClick={() => handleDownloadAll(catNotInstalled)}
                        className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground/50 hover:text-foreground hover:bg-accent/40 transition-colors shrink-0">
                        <Download className="size-2.5" /> Add all
                      </button>
                    )}
                  </div>

                  {catOpen && (
                    <div className="space-y-1.5">
                      {entries.map(entry => {
                        const dl = downloads.get(entry.sourceId)
                        const variantKey = getVariant(entry)
                        const variant = entry.variants.find(v => v.key === variantKey) ?? entry.variants[0]
                        const isActive = dl?.status === 'downloading'
                        const dlStatus = toDlStatus(dl)

                        return (
                          <div key={entry.sourceId} className="overflow-hidden rounded-xl border border-border/60 bg-card/60">
                            <div className="flex items-center gap-3 px-3 py-2.5">
                              <div className={cn('flex size-4 shrink-0 items-center justify-center rounded-full',
                                entry.installed || dlStatus === 'completed' ? 'bg-emerald-500/15' : 'bg-muted')}>
                                {entry.installed || dlStatus === 'completed'
                                  ? <CheckCircle2 className="size-2.5 text-emerald-400" />
                                  : <div className="size-1.5 rounded-full bg-muted-foreground/30" />}
                              </div>
                              {entry.faviconUrl && <img src={entry.faviconUrl} className="size-4 shrink-0 rounded" alt="" />}
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-semibold leading-tight">{entry.label}</p>
                                <p className="text-[11px] text-muted-foreground leading-snug line-clamp-1">{entry.description}</p>
                              </div>
                              {entry.variants.length > 1 && !isActive && (
                                <select value={variantKey}
                                  onChange={e => setVariants(prev => new Map(prev).set(entry.sourceId, e.target.value))}
                                  className="h-6 rounded-md border border-input bg-background px-1.5 text-[11px] focus:outline-none shrink-0">
                                  {entry.variants.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
                                </select>
                              )}
                              {variant && variant.approxBytes > 0 && (
                                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">~{formatFeatureBytes(variant.approxBytes)}</span>
                              )}
                              <div className="shrink-0 flex items-center gap-1">
                                {isActive ? (
                                  <button type="button" onClick={() => handleCancel(entry.sourceId)}
                                    className="rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">Cancel</button>
                                ) : (
                                  <>
                                    {entry.installed && (
                                      <button type="button" onClick={() => setConfirmDeleteId(entry.sourceId)}
                                        className="rounded-lg p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors">
                                        <Trash2 className="size-3" />
                                      </button>
                                    )}
                                    <button type="button" onClick={() => handleDownload(entry.sourceId, variantKey)}
                                      className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-brand/40 hover:bg-brand/5 transition-colors">
                                      <Download className="size-2.5" />
                                      {entry.installed ? 'Update' : 'Add'}
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                            {dl && dl.status !== 'cancelled' && (
                              <div className="border-t border-border/50 px-3 pb-2.5 pt-2">
                                <DownloadProgress label={entry.label} description={isActive ? dl.statusMsg || undefined : undefined}
                                  status={dlStatus} downloadedBytes={dl.completed} totalBytes={dl.total}
                                  speedBps={dl.speedBps} etaSeconds={dl.etaSeconds} error={dl.error ?? undefined} />
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={open => !open && setConfirmDeleteId(null)}
        title="Remove content pack?"
        description="This will delete the downloaded file. You can re-download it at any time."
        confirmLabel="Remove"
        destructive
        onConfirm={() => { if (confirmDeleteId) { void handleDelete(confirmDeleteId); setConfirmDeleteId(null) } }}
      />
    </div>
  )
}

// ── LoRAs browse modal ────────────────────────────────────────────────────────

interface SearchHit {
  modelId: number; versionId: number; name: string; versionName?: string
  author?: string; baseModel?: string; downloadUrl: string; fileName?: string
  sizeKb?: number; triggerTokens: string[]; sourceUrl: string
  thumbnailUrl?: string; downloadCount: number; thumbsUpCount: number; isNsfw: boolean
  allowCommercialUse?: string; allowDerivatives?: boolean; allowNoCredit?: boolean
}
interface ImportState {
  status: 'downloading' | 'done' | 'error'
  completed: number; total: number; speedBps: number; etaSeconds: number; error?: string
}
type SortOption = 'downloads' | 'relevance' | 'newest' | 'highest_rated'

function LorasBrowseModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { user } = useAuth()
  const [inputValue, setInputValue] = useState('')
  const [query, setQuery]           = useState('')
  const [sort, setSort]             = useState<SortOption>('downloads')
  const [showAdult, setShowAdult]   = useState(false)
  const [hits, setHits]             = useState<SearchHit[]>([])
  const [searching, setSearching]   = useState(false)
  const [imports, setImports]       = useState<Map<number, ImportState>>(new Map())
  const [currentPage, setCurrentPage] = useState(0)
  const [maxPage, setMaxPage]         = useState(0)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loraNoticeSeen, setLoraNoticeSeen] = useState(false)
  const [showLoraNotice, setShowLoraNotice] = useState(false)
  const [pendingHit, setPendingHit]         = useState<SearchHit | null>(null)
  const cursorsRef  = useRef<Record<string, string>[]>([{}])
  const inputRef    = useRef<HTMLInputElement>(null)
  const resultsRef  = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then(r => r.json())
      .then((p: Record<string, unknown>) => { if (p['consent.lora_license_notice'] === true) setLoraNoticeSeen(true) })
      .catch(() => {})
  }, [user?.id])

  const handleSubmit = () => {
    if (!inputValue.trim()) { setQuery(''); setHits([]); return }
    setQuery(inputValue)
  }

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    setCurrentPage(0); setMaxPage(0); setHasNextPage(false); cursorsRef.current = [{}]
  }, [query, sort])

  useEffect(() => {
    if (!query.trim()) return
    if (resultsRef.current) {
      const ctrl = new AbortController()
      let innerTimer: ReturnType<typeof setTimeout> | null = null
      const debounceRef = setTimeout(() => {
        const cursors = cursorsRef.current[currentPage] ?? {}
        const delay = currentPage === 0 ? 300 : 0
        innerTimer = setTimeout(() => {
          setSearching(true)
          fetch('/api/admin/image-loras/civitai-search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query.trim(), limit: 40, sort, nsfw: true, cursors }),
            credentials: 'include',
            signal: ctrl.signal,
          })
            .then(r => r.json())
            .then((d: { hits?: SearchHit[]; nextCursors?: Record<string, string>; hasNextPage?: boolean }) => {
              if (ctrl.signal.aborted) return
              setHits(d.hits ?? [])
              const next = d.hasNextPage ?? false
              setHasNextPage(next)
              if (next && d.nextCursors && !cursorsRef.current[currentPage + 1]) {
                cursorsRef.current[currentPage + 1] = d.nextCursors
              }
              setMaxPage(p => Math.max(p, currentPage))
              resultsRef.current?.scrollTo({ top: 0 })
            })
            .catch(() => {})
            .finally(() => { if (!ctrl.signal.aborted) setSearching(false) })
        }, delay)
      }, 0)
      return () => { clearTimeout(debounceRef); if (innerTimer) clearTimeout(innerTimer); ctrl.abort() }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, query, sort])

  function setImport(versionId: number, patch: Partial<ImportState>) {
    setImports(prev => {
      const next = new Map(prev)
      const cur = next.get(versionId) ?? { status: 'downloading' as const, completed: 0, total: 0, speedBps: 0, etaSeconds: 0 }
      next.set(versionId, { ...cur, ...patch })
      return next
    })
  }

  async function acceptLoraNotice() {
    if (user?.id) {
      await fetch(`/api/users/${user.id}/preferences`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'consent.lora_license_notice': true }),
        credentials: 'include',
      }).catch(() => {})
    }
    setLoraNoticeSeen(true)
    setShowLoraNotice(false)
    if (pendingHit) { void handleImport(pendingHit); setPendingHit(null) }
  }

  function initiateImport(hit: SearchHit) {
    if (!loraNoticeSeen) { setPendingHit(hit); setShowLoraNotice(true); return }
    void handleImport(hit)
  }

  async function handleImport(hit: SearchHit) {
    if (imports.has(hit.versionId)) return
    setImport(hit.versionId, { status: 'downloading', completed: 0, total: 0, speedBps: 0, etaSeconds: 0 })
    const res = await fetch('/api/admin/image-loras/civitai-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        downloadUrl: hit.downloadUrl, fileName: hit.fileName ?? `lora_v${hit.versionId}.safetensors`,
        name: hit.name, sourceUrl: hit.sourceUrl, author: hit.author, thumbnailUrl: hit.thumbnailUrl,
        triggerTokens: hit.triggerTokens, civitaiModelId: hit.modelId, versionId: hit.versionId,
        isNsfw: hit.isNsfw,
      }),
    })
    if (!res.ok || !res.body) { setImport(hit.versionId, { status: 'error', completed: 0, total: 0, speedBps: 0, etaSeconds: 0, error: 'Request failed' }); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', currentEvent = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue }
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim(); if (!raw) continue
        try {
          const d = JSON.parse(raw) as Record<string, unknown>
          if (currentEvent === 'progress') setImport(hit.versionId, { status: 'downloading', completed: Number(d.completed ?? 0), total: Number(d.total ?? 0), speedBps: Number(d.speedBps ?? 0), etaSeconds: Number(d.etaSeconds ?? 0) })
          else if (currentEvent === 'done') { setImport(hit.versionId, { status: 'done', completed: 1, total: 1, speedBps: 0, etaSeconds: 0 }); onImported() }
          else if (currentEvent === 'error') setImport(hit.versionId, { status: 'error', completed: 0, total: 0, speedBps: 0, etaSeconds: 0, error: String(d.message ?? 'Import failed') })
        } catch { /* malformed */ }
      }
    }
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="flex flex-col gap-0 p-0 w-[90vw] max-w-5xl h-[85vh] overflow-hidden">
        <DialogHeader className="shrink-0 px-5 pt-5 pb-4 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-brand shrink-0" />
            <DialogTitle className="text-base">Browse LoRAs</DialogTitle>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Search CivitAI — SDXL compatible models</p>
        </DialogHeader>

        <div className="shrink-0 px-5 py-3 border-b border-border/40 space-y-2.5">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50 pointer-events-none" />
              <input ref={inputRef} value={inputValue} onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
                placeholder="Search for a style, character, concept…"
                className="w-full rounded-xl border border-border bg-card pl-9 pr-9 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40" />
              {inputValue && (
                <button onClick={() => { setInputValue(''); setQuery(''); setHits([]) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <button onClick={handleSubmit}
              className="flex items-center justify-center size-10 rounded-xl bg-brand text-white hover:bg-brand/90 transition-colors shrink-0"
              title="Search">
              <ArrowRight className="size-4" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            <select value={sort} onChange={e => setSort(e.target.value as SortOption)}
              className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand/40">
              <option value="downloads">Most downloaded</option>
              <option value="highest_rated">Highest rated</option>
              <option value="newest">Newest</option>
              <option value="relevance">Relevance</option>
            </select>
            <button type="button" onClick={() => setShowAdult(v => !v)}
              className={cn('flex items-center gap-1.5 h-8 rounded-lg border px-3 text-xs font-medium transition-colors',
                showAdult ? 'border-rose-500/50 bg-rose-500/10 text-rose-400' : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted')}>
              {showAdult ? '🔞 Adult on' : 'Adult off'}
            </button>
            {searching && <Loader2 className="size-3.5 animate-spin text-muted-foreground/50 ml-auto" />}
          </div>
        </div>

        <div ref={resultsRef} className="flex-1 overflow-y-auto px-5 py-5 min-h-0">
          {!searching && hits.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground/60">
              {query ? `No results for "${query}"` : 'Type a style, character, or concept and press →'}
            </p>
          )}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {hits.map(hit => {
              const imp = imports.get(hit.versionId)
              const pct = imp && imp.total > 0 ? Math.round((imp.completed / imp.total) * 100) : 0
              return (
                <div key={hit.versionId} className="group flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card hover:border-brand/40 transition-colors">
                  <div className="relative aspect-[3/4] bg-muted overflow-hidden">
                    {hit.thumbnailUrl ? (
                      <img src={hit.thumbnailUrl} alt="" className={cn('absolute inset-0 size-full object-cover', hit.isNsfw && !showAdult && 'blur-xl')} />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Sparkles className="size-8 text-muted-foreground/20" />
                      </div>
                    )}
                    {imp?.status === 'downloading' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 gap-2 px-3">
                        <Loader2 className="size-5 animate-spin text-white" />
                        <div className="w-full h-1.5 rounded-full bg-white/20 overflow-hidden">
                          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[11px] text-white/70 tabular-nums">{pct}%</span>
                      </div>
                    )}
                    {imp?.status === 'done' && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                        <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/90 px-3 py-1.5">
                          <CheckCircle2 className="size-3.5 text-white" />
                          <span className="text-xs font-semibold text-white">Added</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 p-3">
                    <p className="text-xs font-semibold leading-tight line-clamp-2">{hit.name}</p>
                    {hit.versionName && <p className="text-[10px] text-muted-foreground/50 truncate">{hit.versionName}</p>}
                    {hit.baseModel && (
                      <span className="self-start rounded-md bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand leading-none">{hit.baseModel}</span>
                    )}
                    <div className="flex items-center justify-between gap-1">
                      {hit.author && <p className="text-[10px] text-muted-foreground/50 truncate">by {hit.author}</p>}
                      {hit.sourceUrl && (
                        <a href={hit.sourceUrl} target="_blank" rel="noopener noreferrer"
                          className="shrink-0 text-[10px] text-muted-foreground/40 hover:text-brand transition-colors"
                          onClick={e => e.stopPropagation()}>View ↗</a>
                      )}
                    </div>
                    {hit.triggerTokens.length > 0 && (
                      <p className="text-[10px] font-mono text-sky-400/70 truncate">
                        {hit.triggerTokens.slice(0, 2).join(', ')}{hit.triggerTokens.length > 2 ? '…' : ''}
                      </p>
                    )}
                    {(hit.allowCommercialUse === 'None' || hit.allowDerivatives === false) && (
                      <div className="flex flex-wrap gap-1">
                        {hit.allowCommercialUse === 'None' && (
                          <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400 leading-none">Non-commercial</span>
                        )}
                        {hit.allowDerivatives === false && (
                          <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400 leading-none">No derivatives</span>
                        )}
                      </div>
                    )}
                    {imp?.status === 'error' && <p className="text-[10px] text-destructive line-clamp-2">{imp.error}</p>}
                    {!imp ? (
                      <button onClick={() => initiateImport(hit)}
                        className="mt-0.5 flex items-center justify-center gap-1.5 rounded-lg border border-border py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-brand/40 hover:bg-brand/5 transition-colors">
                        <Download className="size-3" /> Add
                      </button>
                    ) : imp.status === 'error' ? (
                      <button onClick={() => { setImports(p => { const n = new Map(p); n.delete(hit.versionId); return n }); void handleImport(hit) }}
                        className="mt-0.5 rounded-lg border border-destructive/30 py-1.5 text-xs text-destructive hover:bg-destructive/5 transition-colors">Retry</button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {(currentPage > 0 || hasNextPage) && (
          <div className="shrink-0 flex items-center justify-center gap-1.5 border-t border-border/40 px-5 py-3">
            <button type="button" disabled={currentPage === 0 || searching} onClick={() => setCurrentPage(p => p - 1)}
              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 transition-colors">← Prev</button>
            <div className="flex items-center gap-1">
              {Array.from({ length: maxPage + (hasNextPage ? 2 : 1) }, (_, i) => (
                <button key={i} type="button" disabled={searching || i > maxPage + 1} onClick={() => setCurrentPage(i)}
                  className={cn('min-w-[2rem] rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    i === currentPage ? 'border-brand/50 bg-brand/10 text-brand' : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40')}>
                  {i + 1}
                </button>
              ))}
            </div>
            <button type="button" disabled={!hasNextPage || searching} onClick={() => setCurrentPage(p => p + 1)}
              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 transition-colors">Next →</button>
          </div>
        )}

        <Dialog open={showLoraNotice} onOpenChange={open => { if (!open) { setShowLoraNotice(false); setPendingHit(null) } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Model licenses</DialogTitle>
              <DialogDescription className="sr-only">License acknowledgment for CivitAI models</DialogDescription>
            </DialogHeader>
            <p className="text-sm text-foreground leading-relaxed">
              Models on CivitAI carry individual license terms set by their creators. Some restrict commercial use or derivatives. By downloading, you agree to comply with that model&apos;s license — check the <strong>View ↗</strong> link on each card before use in any commercial or public project.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              You&apos;ll only see this once. License badges (<span className="font-medium text-amber-400">Non-commercial</span> / <span className="font-medium text-amber-400">No derivatives</span>) appear on restricted models.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button"
                onClick={() => { setShowLoraNotice(false); setPendingHit(null) }}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">
                Cancel
              </button>
              <button type="button"
                onClick={() => void acceptLoraNotice()}
                className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 transition-colors">
                Got it
              </button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}

// ── LoRAs section ─────────────────────────────────────────────────────────────

interface LoraRow {
  id: string; name: string; description: string | null; categoryName: string | null
  triggerTokens: string[]; enabled: boolean; thumbnailUrl: string | null
  styleLabel: string | null; sizeBytes: number | null; fileExists: boolean
}

function LorasSection({ imageGenInstalled, query }: { imageGenInstalled: boolean; query: string }) {
  const [loras, setLoras]               = useState<LoraRow[]>([])
  const [loading, setLoading]           = useState(true)
  const [browsing, setBrowsing]         = useState(false)
  const [deleting, setDeleting]         = useState<Set<string>>(new Set())
  const [toggling, setToggling]         = useState<Set<string>>(new Set())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const loadLoras = useCallback(() => {
    setLoading(true)
    fetch('/api/admin/image-loras', { credentials: 'include' })
      .then(r => r.json())
      .then((rows: LoraRow[]) => setLoras(rows))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadLoras() }, [loadLoras])

  async function handleDelete(id: string) {
    setDeleting(prev => new Set(prev).add(id))
    await fetch(`/api/admin/image-loras/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
    setLoras(prev => prev.filter(l => l.id !== id))
    setDeleting(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  async function handleToggle(id: string, enabled: boolean) {
    setToggling(prev => new Set(prev).add(id))
    setLoras(prev => prev.map(l => l.id === id ? { ...l, enabled } : l))
    await fetch(`/api/admin/image-loras/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }), credentials: 'include',
    }).catch(() => {})
    setToggling(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const filtered = query
    ? loras.filter(l => qMatch(l.name, query) || qMatch(l.categoryName ?? '', query) || l.triggerTokens.some(t => qMatch(t, query)))
    : loras

  if (query && filtered.length === 0) return null

  return (
    <div className={cn('space-y-2', !imageGenInstalled && 'opacity-40 pointer-events-none')}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          LoRA Styles {loras.length > 0 && `· ${loras.filter(l => l.enabled).length}/${loras.length} enabled`}
        </span>
        {imageGenInstalled && (
          <button type="button" onClick={() => setBrowsing(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-brand/40 hover:bg-brand/5 transition-colors">
            <Search className="size-3" /> Browse CivitAI
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-1">
          <Loader2 className="size-3 animate-spin text-muted-foreground/40" />
          <span className="text-xs text-muted-foreground/40">Loading…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border/40 py-4 text-center">
          <Sparkles className="size-5 text-muted-foreground/25" />
          <p className="text-xs text-muted-foreground/50">No LoRAs installed yet.</p>
          <button type="button" onClick={() => setBrowsing(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-brand/40 hover:bg-brand/5 transition-colors">
            <Search className="size-3" /> Browse CivitAI
          </button>
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {filtered.map(lora => (
            <div key={lora.id} className="shrink-0 w-24 group relative">
              <div className={cn('relative aspect-[3/4] overflow-hidden rounded-xl border',
                lora.enabled ? 'border-border/60' : 'border-border/30 opacity-50')}>
                {lora.thumbnailUrl ? (
                  <img src={lora.thumbnailUrl} alt="" className="absolute inset-0 size-full object-cover" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-muted">
                    <Sparkles className="size-5 text-muted-foreground/20" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2 gap-1">
                  <button type="button" disabled={toggling.has(lora.id)} onClick={() => handleToggle(lora.id, !lora.enabled)}
                    className={cn('flex items-center justify-center gap-1 rounded-md py-1 text-[10px] font-medium transition-colors',
                      lora.enabled ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-brand/80 text-white hover:bg-brand')}>
                    {lora.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" disabled={deleting.has(lora.id)} onClick={() => setConfirmDeleteId(lora.id)}
                    className="flex items-center justify-center rounded-md py-1 text-[10px] text-white/70 bg-black/30 hover:bg-red-500/70 transition-colors">
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
              <p className="mt-1 text-[11px] font-medium leading-tight truncate text-center">{lora.name}</p>
              {!lora.fileExists && <p className="text-[10px] text-amber-400 text-center">Missing</p>}
            </div>
          ))}
        </div>
      )}

      {browsing && <LorasBrowseModal onClose={() => setBrowsing(false)} onImported={loadLoras} />}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={open => !open && setConfirmDeleteId(null)}
        title="Remove LoRA style?"
        description="This will permanently delete the style file. You can re-import it from CivitAI at any time."
        confirmLabel="Remove"
        destructive
        onConfirm={() => { if (confirmDeleteId) { void handleDelete(confirmDeleteId); setConfirmDeleteId(null) } }}
      />
    </div>
  )
}

// ── Tools section (categorized) ───────────────────────────────────────────────
// Rendered under the Apps tab (Apps is the home for tools). Exported for that use.

export function ToolsSection({ query, focusToolId }: { query: string; focusToolId?: string }) {
  const [tools, setTools]           = useState<ToolInfo[]>([])
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = useState<string | null>(focusToolId ?? null)
  const [globalConfig, setGlobalConfig] = useState<GlobalConfig>({})
  const [users, setUsers]               = useState<ToolUser[]>([])
  const [permissions, setPermissions]   = useState<Permissions>({})
  const [configLoaded, setConfigLoaded] = useState(false)
  const [drafts, setDrafts]             = useState<Record<string, string>>({})
  const [savingField, setSavingField]   = useState<Record<string, boolean>>({})
  const [showSecret, setShowSecret]     = useState<Record<string, boolean>>({})
  const [savingPerm, setSavingPerm]     = useState<Record<string, boolean>>({})
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set([...TOOL_CATEGORY_ORDER, 'Other']))

  useEffect(() => {
    let cancelled = false
    fetch('/api/tools', { credentials: 'include' }).then(r => r.json()).catch(() => [])
      .then((toolData: unknown) => {
        if (cancelled) return
        if (Array.isArray(toolData)) setTools(toolData as ToolInfo[])
      }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Auto-load config when arriving via a settings deep-link.
  useEffect(() => {
    if (focusToolId) void loadConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToolId])

  async function loadConfig() {
    if (configLoaded) return
    const [cfg, usr, perms] = await Promise.all([
      fetch('/api/tools/config/global', { credentials: 'include' }).then(r => r.json()).catch(() => ({})),
      fetch('/api/users', { credentials: 'include' }).then(r => r.json()).catch(() => []),
      fetch('/api/tools/permissions', { credentials: 'include' }).then(r => r.json()).catch(() => ({})),
    ])
    setGlobalConfig(cfg ?? {}); setUsers(Array.isArray(usr) ? (usr as ToolUser[]).filter(u => u.role !== 'admin') : [])
    setPermissions(perms ?? {}); setConfigLoaded(true)
  }

  function handleExpand(id: string) {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id); loadConfig()
  }

  async function doToggleTool(id: string, enabled: boolean) {
    setSaving(prev => new Set(prev).add(id))
    setTools(prev => prev.map(t => t.id === id ? { ...t, enabled } : t))
    try {
      await fetch(`/api/tools/${id}/enabled`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }), credentials: 'include' })
    } finally { setSaving(prev => { const next = new Set(prev); next.delete(id); return next }) }
  }

  function toggleTool(id: string, enabled: boolean) {
    void doToggleTool(id, enabled)
  }

  async function saveConfigField(toolId: string, key: string, value: string | boolean) {
    const fk = `${toolId}.${key}`
    setSavingField(prev => ({ ...prev, [fk]: true }))
    // Backend expects a single { toolId, key, value } and upserts it (JSON-encoding value).
    await fetch('/api/tools/config/global', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId, key, value }), credentials: 'include' }).catch(() => {})
    setGlobalConfig(prev => ({ ...prev, [toolId]: { ...(prev[toolId] ?? {}), [key]: value } }))
    setDrafts(prev => { const next = { ...prev }; delete next[fk]; return next })
    setSavingField(prev => ({ ...prev, [fk]: false }))
  }

  async function togglePerm(toolId: string, userId: string) {
    const pk = `${toolId}.${userId}`
    const current = permissions[toolId]?.[userId]
    const next: 'allow' | 'deny' = current === 'deny' ? 'allow' : 'deny'
    setSavingPerm(prev => ({ ...prev, [pk]: true }))
    setPermissions(prev => ({ ...prev, [toolId]: { ...(prev[toolId] ?? {}), [userId]: next } }))
    // Backend expects `state` (not `permission`).
    await fetch('/api/tools/permissions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId, userId, state: next }), credentials: 'include' }).catch(() => {})
    setSavingPerm(prev => ({ ...prev, [pk]: false }))
  }

  function toggleCategory(cat: string) {
    setOpenCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  // When arriving via a settings deep-link, show only the focused tool.
  const groupNameMatches = query && (qMatch('tools', query) || qMatch('capabilities', query))
  const filteredTools = focusToolId
    ? tools.filter(t => t.id === focusToolId)
    : query && !groupNameMatches
      ? tools.filter(t => qMatch(t.name, query) || qMatch(t.description, query) || t.examples.some(ex => qMatch(ex, query)))
      : tools

  const categoryMap = useMemo(() => {
    const map = new Map<string, ToolInfo[]>()
    for (const tool of filteredTools) {
      const cat = TOOL_ICONS[tool.id]?.category ?? 'Other'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(tool)
    }
    return map
  }, [filteredTools])

  // Early-out must come after all hooks so hook order stays stable across renders.
  if (!focusToolId && query && filteredTools.length === 0) return null

  const orderedCategories = ([...TOOL_CATEGORY_ORDER, 'Other'] as string[]).filter(c => categoryMap.has(c))

  return (
    <div className="space-y-5">
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-4 animate-spin text-muted-foreground/40" />
        </div>
      ) : (
        orderedCategories.map(cat => {
          const catTools = categoryMap.get(cat)!
          const enabledCount = catTools.filter(t => t.enabled).length
          const catOpen = (query || focusToolId) ? true : openCategories.has(cat)

          return (
            <div key={cat}>
              <div className="-mx-5 mb-2 px-5 py-1.5">
                <button type="button"
                  className="flex items-center gap-2 w-full"
                  onClick={() => !query && toggleCategory(cat)}>
                  <ChevronDown className={cn('size-3.5 text-muted-foreground/70 transition-transform', !catOpen && '-rotate-90')} />
                  <span className="text-xs font-bold uppercase tracking-wider text-foreground/80">{cat}</span>
                  <span className="text-[10px] font-medium text-muted-foreground tabular-nums">{enabledCount}/{catTools.length}</span>
                </button>
              </div>

              {catOpen && (
                <div className="space-y-2">
                  {catTools.map(tool => {
                    const meta = TOOL_ICONS[tool.id] ?? { icon: Wrench, chip: 'bg-muted text-muted-foreground' }
                    const ToolIcon = meta.icon
                    const isExpanded   = expandedId === tool.id
                    const globalFields = (tool.configSchema ?? []).filter(f => f.scope === 'global' || f.scope === 'both')
                    const hasConfig    = globalFields.length > 0

                    return (
                      <div key={tool.id} className="overflow-hidden rounded-2xl border border-border/60 bg-card">
                        <div className="flex items-center gap-3 px-4 py-3">
                          <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', meta.chip)}>
                            <ToolIcon className="size-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-semibold leading-tight">{tool.name}</p>
                              {tool.core && <span className="text-[9px] font-bold text-brand uppercase tracking-wide">Core</span>}
                              {!tool.offline && (
                                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/40">
                                  <Wifi className="size-2.5" /> internet
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{tool.description}</p>
                          </div>
                          {hasConfig && (
                            <button type="button" onClick={() => handleExpand(tool.id)}
                              className={cn('shrink-0 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                                isExpanded ? 'border-brand/40 bg-brand/8 text-brand' : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/40')}>
                              <Settings2 className="size-3" />
                              {isExpanded ? 'Done' : 'Config'}
                            </button>
                          )}
                          <ToggleSwitch checked={tool.enabled} disabled={tool.core || saving.has(tool.id)} onChange={enabled => toggleTool(tool.id, enabled)} />
                        </div>

                        {isExpanded && (
                          <div className="border-t border-border/50 px-4 py-3 space-y-4">
                            {globalFields.length > 0 && (
                              <div className="space-y-3">
                                {globalFields.map(field => {
                                  const fk = `${tool.id}.${field.key}`
                                  const rawVal     = globalConfig[tool.id]?.[field.key] ?? field.default
                                  // Boolean fields render as a toggle that saves immediately.
                                  if (field.type === 'boolean') {
                                    const checked = rawVal === true
                                    return (
                                      <div key={field.key} className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <label className="text-xs font-medium">{field.label}</label>
                                          {field.description && <p className="text-[10px] text-muted-foreground/60">{field.description}</p>}
                                        </div>
                                        <ToggleSwitch checked={checked} disabled={savingField[fk]}
                                          onChange={v => saveConfigField(tool.id, field.key, v)} />
                                      </div>
                                    )
                                  }
                                  const currentVal = String(rawVal ?? '')
                                  const draftVal   = drafts[fk]
                                  const displayVal = draftVal ?? currentVal
                                  const isSecret   = field.type === 'secret'
                                  const visible    = showSecret[fk]
                                  const isDirty    = draftVal !== undefined && draftVal !== currentVal
                                  return (
                                    <div key={field.key} className="space-y-1.5">
                                      <label className="text-xs font-medium">{field.label}</label>
                                      {field.description && <p className="text-[10px] text-muted-foreground/60">{field.description}</p>}
                                      <div className="flex gap-2">
                                        <div className="relative flex-1">
                                          <input type={isSecret && !visible ? 'password' : 'text'} value={displayVal}
                                            placeholder={field.placeholder}
                                            onChange={e => setDrafts(prev => ({ ...prev, [fk]: e.target.value }))}
                                            className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand/40 pr-8" />
                                          {isSecret && (
                                            <button type="button" onClick={() => setShowSecret(prev => ({ ...prev, [fk]: !visible }))}
                                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors">
                                              {visible ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                                            </button>
                                          )}
                                        </div>
                                        {isDirty && (
                                          <button type="button" disabled={savingField[fk]}
                                            onClick={() => saveConfigField(tool.id, field.key, draftVal!)}
                                            className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs text-brand-foreground hover:opacity-90 disabled:opacity-50 transition-colors">
                                            {savingField[fk] ? '…' : 'Save'}
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                            {configLoaded && users.length > 0 && (
                              <div className="space-y-2">
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Who can use this</p>
                                <div className="flex flex-wrap gap-2">
                                  {users.map(u => {
                                    const pk     = `${tool.id}.${u.id}`
                                    const denied = permissions[tool.id]?.[u.id] === 'deny'
                                    return (
                                      <button key={u.id} type="button" disabled={savingPerm[pk]}
                                        onClick={() => togglePerm(tool.id, u.id)}
                                        className={cn('flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
                                          denied ? 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                                            : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20',
                                          savingPerm[pk] && 'opacity-50')}>
                                        {u.nickname || u.firstName}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            )}
                            {tool.id === 'homeAssistant' && (
                              <AdminHomeAssistantSection users={users} />
                            )}
                            {tool.id === 'youtube' && (
                              <AdminYoutubeLimitsSection />
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })
      )}

    </div>
  )
}

// ── AdminFeaturesTab ──────────────────────────────────────────────────────────

const SECTION_ANCHOR: Record<string, string> = {
  chat: 'section-chat',
  images: 'section-images',
  voice: 'section-voice',
  capabilities: 'section-capabilities',
}

export function AdminFeaturesTab({ view }: { view?: string } = {}) {
  const { user } = useAuth()
  const [catalog, setCatalog] = useState<FullCatalogResponse | null>(null)
  const [compMap, setCompMap] = useState<Map<string, boolean>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [installStates, setInstallStates] = useState<Map<string, InstallState>>(new Map())
  const [selectedTier, setSelectedTier] = useState('')
  const [activeLlmId, setActiveLlmId] = useState<string | null>(null)
  const faceIdSeenRef = useRef(false)
  const [showFaceIdNotice, setShowFaceIdNotice] = useState(false)
  const [pendingEntry, setPendingEntry] = useState<CatalogEntry | null>(null)
  const abortRefs = useRef<Map<string, AbortController>>(new Map())

  const loadAll = useCallback(async () => {
    setLoading(true); setLoadError('')
    try {
      const [compRes, catRes] = await Promise.all([
        fetch('/api/admin/install', { credentials: 'include' }),
        fetch('/api/setup/catalog', { credentials: 'include' }),
      ])
      if (catRes.ok) {
        const data = await catRes.json() as FullCatalogResponse
        setCatalog(data)
        setSelectedTier(t => t || data.recommendedTier)
        const llmId = Object.values(data.activeModelIds ?? {}).find(id => {
          if (!id) return false
          const m = data.models.find(m => m.id === id)
          return m && LLM_ROLES_SET.has(m.role)
        }) ?? null
        setActiveLlmId(llmId)
      }
      if (compRes.ok) {
        const { components } = await compRes.json() as { components: { id: string; installed: boolean }[] }
        const map = new Map<string, boolean>()
        for (const c of components) map.set(c.id, c.installed)
        setCompMap(map)
      }
    } catch { setLoadError('Could not load feature status.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then(r => r.json())
      .then((p: Record<string, unknown>) => { if (p['consent.faceid_notice'] === true) faceIdSeenRef.current = true })
      .catch(() => {})
  }, [user?.id])

  useEffect(() => {
    if (!view || loading) return
    const anchorId = SECTION_ANCHOR[view]
    if (!anchorId) return
    const t = setTimeout(() => {
      document.getElementById(anchorId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 120)
    return () => clearTimeout(t)
  }, [view, loading])

  function setInstallState(id: string, patch: Partial<InstallState>) {
    setInstallStates(prev => {
      const next = new Map(prev)
      const cur = next.get(id) ?? { status: 'idle' as DownloadStatus, completed: 0, total: 0, speedBps: 0, etaSeconds: 0 }
      next.set(id, { ...cur, ...patch })
      return next
    })
  }

  async function repairComponent(componentId: string, stateId: string) {
    const ctrl = new AbortController()
    abortRefs.current.set(stateId, ctrl)
    setInstallState(stateId, { status: 'downloading', completed: 0, total: 0, speedBps: 0, etaSeconds: 0, error: undefined })
    try {
      const res = await fetch('/api/admin/install/repair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ componentId }), credentials: 'include', signal: ctrl.signal,
      })
      if (!res.ok || !res.body) { setInstallState(stateId, { status: 'error', error: 'Request failed' }); return }
      const reader = res.body.getReader(); const decoder = new TextDecoder()
      let buf = '', ev = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue }
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim(); if (!raw) continue
          try {
            const d = JSON.parse(raw) as Record<string, unknown>
            if (ev === 'progress') setInstallState(stateId, { status: 'downloading', completed: Number(d.completed ?? 0), total: Number(d.total ?? 0), speedBps: Number(d.speedBps ?? 0), etaSeconds: Number(d.etaSeconds ?? 0), statusMessage: d.message ? String(d.message) : undefined })
            else if (ev === 'done') { setInstallState(stateId, { status: 'completed' }); void loadAll(); return }
            else if (ev === 'error') setInstallState(stateId, { status: 'error', error: d.error as string })
            else if (ev === 'cancelled') { setInstallState(stateId, { status: 'cancelled' }); return }
          } catch { /* malformed */ }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setInstallState(stateId, { status: 'error', error: String(err) })
    }
  }

  async function installOllamaModel(modelId: string, stateId: string) {
    const ctrl = new AbortController()
    abortRefs.current.set(stateId, ctrl)
    setInstallState(stateId, { status: 'downloading', completed: 0, total: 0, speedBps: 0, etaSeconds: 0, error: undefined })
    try {
      const res = await fetch('/api/admin/install/model', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }), credentials: 'include', signal: ctrl.signal,
      })
      if (!res.ok || !res.body) { setInstallState(stateId, { status: 'error', error: 'Request failed' }); return }
      const reader = res.body.getReader(); const decoder = new TextDecoder()
      let buf = '', ev = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue }
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim(); if (!raw) continue
          try {
            const d = JSON.parse(raw) as Record<string, unknown>
            if (ev === 'progress') setInstallState(stateId, { status: 'downloading', completed: Number(d.completed ?? 0), total: Number(d.total ?? 0), speedBps: Number(d.speedBps ?? 0), etaSeconds: Number(d.etaSeconds ?? 0) })
            else if (ev === 'done') { setInstallState(stateId, { status: 'completed' }); void loadAll(); return }
            else if (ev === 'error') setInstallState(stateId, { status: 'error', error: d.error as string })
            else if (ev === 'cancelled') { setInstallState(stateId, { status: 'cancelled' }); return }
          } catch { /* malformed */ }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setInstallState(stateId, { status: 'error', error: String(err) })
    }
  }

  function cancelInstall(stateId: string) {
    abortRefs.current.get(stateId)?.abort()
    setInstallState(stateId, { status: 'cancelled' })
  }

  function installEntry(entry: CatalogEntry) {
    if (entry.role === 'face_id' && !faceIdSeenRef.current) {
      setPendingEntry(entry); setShowFaceIdNotice(true); return
    }
    if (entry.backend === 'ollama') void installOllamaModel(entry.id, entry.id)
    else void repairComponent(entry.id, entry.id)
  }

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  if (loadError || !catalog) return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <p className="text-sm text-destructive">{loadError || 'Could not load catalog.'}</p>
      <button type="button" onClick={loadAll} className="text-xs text-muted-foreground hover:text-foreground">Try again</button>
    </div>
  )

  const tierModels = catalog.models.filter(m => m.tiers.includes(selectedTier))
  const llmCandidates = tierModels.filter(m => LLM_ROLES_SET.has(m.role))
  const activeTierLlm = llmCandidates.find(m => m.id === activeLlmId) ?? llmCandidates.find(m => m.recommended) ?? llmCandidates[0]
  const chatModels = tierModels.filter(m => CHAT_ROLES_SET.has(m.role))
  const imageModels = tierModels.filter(m => IMAGE_GEN_ROLES_SET.has(m.role))
  const voiceModels = tierModels.filter(m => m.role === 'voice')
  const imageGenInstalled = catalog.models.find(m => m.role === 'image_gen')?.installed ?? false

  const ollamaState = installStates.get('ollama-runtime')

  return (
    <div>
      {/* Header */}
      <div className="px-5 pt-5 pb-4 border-b border-border/40 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-black tracking-tight">Your AI</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {catalog.hardware.totalRamGb} GB{catalog.hardware.isAppleSilicon ? ' Apple Silicon' : ''} · {fmtCatalogBytes(catalog.disk.freeBytes)} free
            </p>
          </div>
          <button type="button" onClick={loadAll}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors shrink-0">
            <RefreshCw className="size-3" /> Refresh
          </button>
        </div>

        {catalog.tiers.length > 1 && (
          <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Model size</label>
            <select value={selectedTier} onChange={e => setSelectedTier(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500/40">
              {catalog.tiers.map(t => (
                <option key={t.id} value={t.id}>{t.label}{t.id === catalog.recommendedTier ? ' (recommended for you)' : ''}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground/60">Bigger sizes are smarter but use more memory and respond a little slower.</p>
          </div>
        )}
      </div>

      <div className="px-5 py-6 space-y-8 pb-[600px]">

        {/* Chat & Intelligence */}
        <div id="section-chat" className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Chat &amp; Intelligence</p>

          {/* Ollama runtime row */}
          <div className={cn('rounded-xl border bg-card transition-colors', catalog.ollamaRunning ? 'border-violet-500/20' : 'border-border')}>
            <div className="flex items-center gap-3 px-4 py-3">
              <div className={cn('flex size-5 shrink-0 items-center justify-center rounded-full', catalog.ollamaRunning ? 'bg-emerald-500/15' : 'bg-muted')}>
                {ollamaState?.status === 'downloading'
                  ? <Loader2 className="size-3 animate-spin text-muted-foreground" />
                  : catalog.ollamaRunning
                  ? <CheckCircle2 className="size-3 text-emerald-400" />
                  : <div className="size-1.5 rounded-full bg-muted-foreground/30" />}
              </div>
              <Server className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Runtime</span>
                <p className="text-sm font-semibold leading-tight">{catalog.ollamaRunning ? 'Ollama · running' : 'Ollama'}</p>
              </div>
              <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">~{fmtCatalogBytes(catalog.ollamaInstallBytes)}</span>
              <div className="shrink-0">
                {ollamaState?.status === 'downloading' ? (
                  <button type="button" onClick={() => cancelInstall('ollama-runtime')}
                    className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">Cancel</button>
                ) : catalog.ollamaRunning ? (
                  <span className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-emerald-400 bg-emerald-500/8">
                    <CheckCircle2 className="size-2.5" /> Running
                  </span>
                ) : (
                  <button type="button" onClick={() => void repairComponent('ollama-runtime', 'ollama-runtime')}
                    className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-violet-500/40 hover:bg-violet-500/5 transition-colors">
                    <Download className="size-3" /> Install
                  </button>
                )}
              </div>
            </div>
            {ollamaState && ollamaState.status !== 'idle' && (
              <div className="border-t border-border/50 px-4 pb-3 pt-2">
                <DownloadProgress label="Ollama" description={ollamaState.statusMessage} status={ollamaState.status}
                  progress={ollamaState.total > 0 ? Math.round((ollamaState.completed / ollamaState.total) * 100) : undefined}
                  downloadedBytes={ollamaState.completed} totalBytes={ollamaState.total}
                  speedBps={ollamaState.speedBps} etaSeconds={ollamaState.etaSeconds} error={ollamaState.error} />
              </div>
            )}
          </div>

          {activeTierLlm && (
            <ModelInstallRow
              entry={activeTierLlm}
              isActive={activeTierLlm.id === activeLlmId}
              installState={installStates.get(activeTierLlm.id)}
              onInstall={() => installEntry(activeTierLlm)}
              onCancel={() => cancelInstall(activeTierLlm.id)}
              allEntries={llmCandidates}
              onSwap={e => installEntry(e)}
            />
          )}

          {chatModels
            .filter(m => !(m.role === 'vision' && activeTierLlm?.builtinVision))
            .map(m => (
              <ModelInstallRow key={m.id} entry={m}
                installState={installStates.get(m.id)}
                onInstall={() => installEntry(m)}
                onCancel={() => cancelInstall(m.id)}
              />
            ))}

          {activeTierLlm?.builtinVision && (
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 px-4 py-3 flex items-start gap-3">
              <Eye className="size-4 shrink-0 text-violet-400 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-violet-300">Vision built in</p>
                <p className="text-xs text-muted-foreground mt-0.5">{activeTierLlm.label} understands images natively — no separate vision model needed.</p>
              </div>
            </div>
          )}
        </div>

        {/* Image Generation */}
        {imageModels.length > 0 && (
          <div id="section-images" className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Image Generation</p>

            <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/30 px-4 py-2.5">
              <Server className="size-4 shrink-0 text-muted-foreground/60" />
              <div className="min-w-0 flex-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">Runtime</span>
                <p className="text-sm text-muted-foreground">ComfyUI · included automatically</p>
              </div>
            </div>

            {imageModels.map(m => (
              <ModelInstallRow key={m.id} entry={m}
                installState={installStates.get(m.id)}
                onInstall={() => installEntry(m)}
                onCancel={() => cancelInstall(m.id)}
                blocked={(m.requires ?? []).some(r => !catalog.models.find(c => c.id === r)?.installed)}
              />
            ))}

            <LorasSection imageGenInstalled={imageGenInstalled} query="" />
          </div>
        )}

        {/* Voice */}
        {voiceModels.length > 0 && (
          <div id="section-voice" className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Voice</p>
            {voiceModels.map(m => (
              <ModelInstallRow key={m.id} entry={m}
                installState={installStates.get(m.id)}
                onInstall={() => installEntry(m)}
                onCancel={() => cancelInstall(m.id)}
              />
            ))}
          </div>
        )}

        {/* Base Applications */}
        <div id="section-capabilities" className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Base Applications</p>
          {ADMIN_CAPS.filter(c => c.base).map(cap => (
            <CapInstallRow key={cap.id} cap={cap}
              installed={compMap.get(cap.id) === true}
              installState={installStates.get(cap.id)}
              onInstall={() => void repairComponent(cap.id, cap.id)}
              onCancel={() => cancelInstall(cap.id)}
            />
          ))}
        </div>

        {/* More capabilities */}
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">More Capabilities</p>
          <p className="px-1 text-xs text-muted-foreground/70 -mt-1">Optional — add these at any time.</p>
          {ADMIN_CAPS.filter(c => !c.base).map(cap => (
            <CapInstallRow key={cap.id} cap={cap}
              installed={compMap.get(cap.id) === true}
              blocked={cap.requires.some(r => compMap.get(r) !== true)}
              installState={installStates.get(cap.id)}
              onInstall={() => void repairComponent(cap.id, cap.id)}
              onCancel={() => cancelInstall(cap.id)}
            />
          ))}
        </div>

      </div>

      <Dialog open={showFaceIdNotice} onOpenChange={open => { if (!open) { setShowFaceIdNotice(false); setPendingEntry(null) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Face Identity</DialogTitle>
            <DialogDescription className="sr-only">Privacy notice for face analysis models</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-foreground leading-relaxed">
            Face Identity models extract facial geometry from photos to inject your likeness into generated images. Only use this on photos you own or have explicit rights to process. All analysis happens locally — no images are sent externally.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => { setShowFaceIdNotice(false); setPendingEntry(null) }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors">
              Cancel
            </button>
            <button type="button"
              onClick={async () => {
                faceIdSeenRef.current = true
                setShowFaceIdNotice(false)
                if (user?.id) {
                  await fetch(`/api/users/${user.id}/preferences`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 'consent.faceid_notice': true }), credentials: 'include',
                  }).catch(() => {})
                }
                if (pendingEntry) { installEntry(pendingEntry); setPendingEntry(null) }
              }}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 transition-colors">
              Got it, install
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
