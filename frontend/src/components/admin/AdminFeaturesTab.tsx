import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useAuth } from '@/context/AuthContext'
import {
  ArrowLeftRight, BookOpen, Bot, Calculator, CalendarClock, ChefHat, CheckCircle2,
  ChevronDown, Clock, Cloud, Code2, Cpu, Database, Download, Ear, Eraser, Eye, EyeOff, Film, Globe,
  Home, Laugh, Lightbulb, MapPin, Mic, Moon, Newspaper, Package,
  PartyPopper, Play, RefreshCw, Route, ScanFace, Server, Settings2, ShieldCheck,
  SlidersHorizontal, Stethoscope, Trophy, Tv, Wand2, Wifi, Wrench, Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { StatusDot } from '@/components/shared/StatusDot'
import { cn } from '@/lib/cn'
import { DownloadProgress } from '@/components/shared/DownloadProgress'
import type { DownloadStatus } from '@/components/shared/DownloadProgress'
import { FeatureSwitchRow } from '@/components/admin/FeatureSwitchRow'
import { useFeatureSwitches } from '@/hooks/useFeatureSwitches'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'

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
  default?: string | number | boolean
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
  weather:         { icon: Cloud,          chip: 'bg-info/15 text-info',                    category: 'Information' },
  search:          { icon: Globe,          chip: 'bg-info/15 text-info',                    category: 'Information' },
  news:            { icon: Newspaper,      chip: 'bg-warning/15 text-warning',              category: 'Information' },
  dictionary:      { icon: BookOpen,       chip: 'bg-warning/15 text-warning',              category: 'Information' },
  calculator:      { icon: Calculator,     chip: 'bg-brand/15 text-brand',                  category: 'Utilities'   },
  unit_conversion: { icon: ArrowLeftRight, chip: 'bg-info/15 text-info',                    category: 'Utilities'   },
  jokes:           { icon: Laugh,          chip: 'bg-warning/15 text-warning',              category: 'Lifestyle'   },
  recipes:         { icon: ChefHat,        chip: 'bg-success/15 text-success',              category: 'Lifestyle'   },
  youtube:         { icon: Play,           chip: 'bg-destructive/15 text-destructive',      category: 'Media'       },
  tvshows:         { icon: Tv,             chip: 'bg-brand/15 text-brand',                  category: 'Media'       },
  onthisday:       { icon: CalendarClock,  chip: 'bg-brand/15 text-brand',                  category: 'Information' },
  localNews:       { icon: Newspaper,      chip: 'bg-destructive/15 text-destructive',      category: 'Information' },
  localEvents:     { icon: MapPin,         chip: 'bg-success/15 text-success',              category: 'Lifestyle'   },
  contentRating:   { icon: ShieldCheck,    chip: 'bg-warning/15 text-warning',              category: 'Media'       },
  sports:          { icon: Trophy,         chip: 'bg-warning/15 text-warning',              category: 'Information' },
  datetime:        { icon: Clock,          chip: 'bg-secondary text-muted-foreground',      category: 'Information' },
  moonphase:       { icon: Moon,           chip: 'bg-brand/15 text-brand',                  category: 'Information' },
  medical:         { icon: Stethoscope,    chip: 'bg-destructive/15 text-destructive',      category: 'Lifestyle'   },
  holidays:        { icon: PartyPopper,    chip: 'bg-brand/15 text-brand',                  category: 'Lifestyle'   },
  home_inventory:  { icon: Package,        chip: 'bg-warning/15 text-warning',              category: 'Lifestyle'   },
  homeAssistant:   { icon: Lightbulb,      chip: 'bg-warning/15 text-warning',              category: 'Lifestyle'   },
  'where-to-watch':{ icon: Film,           chip: 'bg-brand/15 text-brand',                  category: 'Media'       },
  image_gen:       { icon: ImageIcon,      chip: 'bg-brand/15 text-brand',                  category: 'Creative'    },
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
  | 'voice' | 'coding' | 'runtime' | 'component'

interface CatalogEntry {
  id: string; role: ModelRole; label: string; description: string
  backend: 'ollama' | 'huggingface' | 'url'; approxBytes: number; tags: string[]
  format?: string; backendLabel?: string; required?: boolean; installed: boolean
  recommended: boolean; tiers: string[]; builtinVision?: boolean
  linkedWith?: string[]; requires?: string[]
}

interface CatalogTier { id: string; label: string; detail: string }

interface FullCatalogResponse {
  hardware: { totalRamGb: number; isAppleSilicon: boolean; platform: string; gpuVendor?: string; cudaDeviceCount?: number }
  recommendedTier: string; tiers: CatalogTier[]; models: CatalogEntry[]
  disk: { freeBytes: number; totalBytes: number }; ollamaRunning: boolean
  ollamaInstallBytes: number; activeModelIds: Record<string, string | null>
  ollamaVersion: string | null
}

interface AdminCapDef {
  id: string; label: string; description: string; bytes: number
  requires: string[]; base?: boolean; icon: ComponentType<{ className?: string }>
}

// ── Constants (direct copy from SetupWizard) ─────────────────────────────────

const ADMIN_CAPS: AdminCapDef[] = [
  { id: 'tesseract',     label: 'Home Inventory', description: 'Snap a photo: AI identifies your devices and tracks warranties (Tesseract OCR)', bytes: 30_000_000,  requires: [],            base: true, icon: Home },
  { id: 'searxng',       label: 'Web Search',      description: 'Local SearXNG metasearch that aggregates Google/Brave/Startpage so web search works where direct scraping is blocked. Auto-updates weekly. Source: github.com/searxng/searxng (AGPL-3.0)', bytes: 300_000_000, requires: [],            icon: Globe },
  { id: 'voice-core',   label: 'Voice',           description: 'Read replies aloud and speak to your AI (Kokoro + Whisper)',                       bytes: 320_000_000, requires: [],                       icon: Mic  },
  { id: 'wakeword-core', label: 'Wake Word',       description: 'Hands-free "Hey Jarvis" activation',                                               bytes: 6_000_000,  requires: ['voice-core'],            icon: Ear  },
  { id: 'esphome',       label: 'Devices',         description: 'Build & flash firmware for ESP32 voice satellites (Atom Echo, etc.) from Admin → Devices. Includes the ESP32 toolchain (~1 GB).', bytes: 1_000_000_000, requires: [],                     icon: Cpu  },
  { id: 'stem-audio',    label: 'Music Studio',    description: 'AI stem separation (Demucs) + tempo/key/chord analysis for the Music Studio: split any song into vocals, drums, bass and more. Managed Python venv; runs fully local. On Windows, analysis runs via librosa (genre/mood auto-tagging stays macOS/Linux-only).', bytes: 2_500_000_000, requires: [],            icon: SlidersHorizontal },
  { id: 'stem-roformer-guitar', label: 'Music Studio: Enhanced Guitar', description: 'Optional guitar upgrade: a RoFormer model that isolates guitar far more cleanly than Demucs. Adds to an existing Music Studio install.', bytes: 2_100_000_000, requires: ['stem-audio'], icon: SlidersHorizontal },
  { id: 'claude-code',   label: 'Coding',          description: 'The real Claude Code CLI, running in a sandboxed dev workspace and pointed at your local coding model, usable from the Coding app\'s terminal or by asking the companion in chat. Edits and commands pause for your approval in the terminal; a chat-triggered background task runs unattended, sandboxed to your own workspace.', bytes: 40_000_000, requires: [], icon: Code2 },
  { id: 'tmux',          label: 'Coding Terminal Multiplexer', description: 'Powers split panes and reload-persistence in the Coding app\'s terminal.', bytes: 2_000_000, requires: ['claude-code'], icon: Code2 },
  { id: 'coding-sandbox-user', label: 'Coding Sandbox Isolation', description: 'Creates a restricted OS user with no access to this app\'s own files, so the coding agent runs fully walled off at the operating-system level instead of only pausing for your approval. One-time admin approval (native macOS/Linux dialog, UAC prompt on Windows); silent after that, and setup verifies the wall actually holds before reporting success. Without this, coding tasks still pause for approval but have no OS-level wall behind it, and chat-triggered background coding tasks are disabled.', bytes: 0, requires: ['claude-code'], icon: ShieldCheck },
  // Rendered only on Windows + NVIDIA (see the More Capabilities section guard).
  { id: 'nvidia-gpu-tuning', label: 'NVIDIA Driver Tuning', description: 'Stops image/video generation from silently crawling when VRAM runs out: sets the driver\'s CUDA sysmem-fallback policy to "prefer none" for python.exe (via NVIDIA Profile Inspector), so over-commits fail fast and ComfyUI uses its own faster tiling instead. Applies to every python.exe on this machine. Re-apply after NVIDIA driver upgrades.', bytes: 450_000, requires: [], icon: Cpu },
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
    <Card variant="surface" className={cn('transition-colors', blocked && 'opacity-50 pointer-events-none',
      isInstalled ? 'border-success/30' : 'border-border')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={cn('flex size-5 shrink-0 items-center justify-center rounded-full',
          isInstalled ? 'bg-success/10' : 'bg-muted')}>
          {isInstalling
            ? <Spinner size="sm" className="size-3" />
            : isInstalled
            ? <CheckCircle2 className="size-3 text-success" />
            : <StatusDot status="off" />}
        </div>
        <RoleIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-overline text-muted-foreground shrink-0">
              {MODEL_ROLE_LABELS[entry.role] ?? entry.role}
            </span>
            {isActive && <span className="text-[10px] font-semibold text-success shrink-0">Active</span>}
            {entry.required && !LLM_ROLES_SET.has(entry.role) && (
              <span className="text-[10px] font-semibold text-brand shrink-0">Required</span>
            )}
            {hasAlts && !isActive && !LLM_ROLES_SET.has(entry.role) && (
              <span className="text-[10px] font-semibold text-brand shrink-0">Choose one</span>
            )}
          </div>
          <p className="text-sm font-semibold leading-tight truncate">{entry.label}</p>
        </div>
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">~{fmtCatalogBytes(entry.approxBytes)}</span>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => { setShowDetails(v => !v); setShowChange(false) }}
            className={cn('gap-0.5 px-2', showDetails ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground')}>
            details <ChevronDown className={cn('size-3 transition-transform', showDetails && 'rotate-180')} />
          </Button>
          {hasAlts && (
            <Button type="button" variant={showChange ? 'tinted' : 'ghost'} size="sm"
              onClick={() => { setShowChange(v => !v); setShowDetails(false) }}
              className={cn('px-2', !showChange && 'text-muted-foreground')}>
              change
            </Button>
          )}
          {isInstalling ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="px-2 text-muted-foreground">
              Cancel
            </Button>
          ) : isInstalled ? (
            <span className="flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold text-success bg-success/10">
              <CheckCircle2 className="size-2.5" /> {isActive ? 'Active' : 'Installed'}
            </span>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={onInstall} className="gap-1 px-2 text-muted-foreground">
              <Download className="size-3" /> Install
            </Button>
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
          <p className="text-overline text-muted-foreground mb-2">Choose model</p>
          {allEntries.map(alt => (
            <button key={alt.id} type="button" onClick={() => { onSwap(alt); setShowChange(false) }}
              className={cn('w-full rounded-control border px-3 py-2.5 text-left transition-all',
                alt.id === entry.id ? 'border-brand/40 bg-brand/10' : 'border-border bg-background/50 hover:border-border/80 hover:bg-accent/30')}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{alt.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{alt.description}</p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="text-xs tabular-nums text-muted-foreground">~{fmtCatalogBytes(alt.approxBytes)}</span>
                  {alt.installed && <CheckCircle2 className="size-3.5 text-success" />}
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
    </Card>
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
    <Card variant="surface" className={cn('transition-colors', blocked && 'opacity-50 pointer-events-none',
      isInstalled ? 'border-success/30' : 'border-border')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={cn('flex size-5 shrink-0 items-center justify-center rounded-full',
          isInstalled ? 'bg-success/10' : 'bg-muted')}>
          {isInstalling
            ? <Spinner size="sm" className="size-3" />
            : isInstalled
            ? <CheckCircle2 className="size-3 text-success" />
            : <StatusDot status="off" />}
        </div>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight">{cap.label}</p>
          <p className="text-xs text-muted-foreground leading-tight truncate">{cap.description}</p>
        </div>
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">~{fmtCatalogBytes(cap.bytes)}</span>
        <div className="shrink-0">
          {isInstalling ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="px-2 text-muted-foreground">
              Cancel
            </Button>
          ) : isInstalled ? (
            <span className="flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold text-success bg-success/10">
              <CheckCircle2 className="size-2.5" /> Installed
            </span>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={onInstall} className="gap-1 px-2 text-muted-foreground">
              <Download className="size-3" /> Install
            </Button>
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
    </Card>
  )
}

// ── Tools section (categorized) ───────────────────────────────────────────────
// Rendered under the Apps tab (Apps is the home for tools). Exported for that use.

// These tools' config fields now live on their own app's settings page (colocation
// convention); the "who can use this" permissions here stay the central place for that,
// so the Config button stays available even though the field list itself is empty.
const MOVED_CONFIG_TOOL_IDS = new Set(['youtube', 'homeAssistant', 'where-to-watch', 'localNews', 'localEvents', 'plex'])

export function ToolsSection({ query, focusToolId }: { query: string; focusToolId?: string }) {
  const [tools, setTools]           = useState<ToolInfo[]>([])
  const [loading, setLoading]       = useState(true)
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
        <SkeletonListRows count={4} className="py-2" />
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
                  <span className="text-overline text-foreground/80">{cat}</span>
                  <span className="text-[10px] font-medium text-muted-foreground tabular-nums">{enabledCount}/{catTools.length}</span>
                </button>
              </div>

              {catOpen && (
                <div className="space-y-2">
                  {catTools.map(tool => {
                    const meta = TOOL_ICONS[tool.id] ?? { icon: Wrench, chip: 'bg-muted text-muted-foreground' }
                    const ToolIcon = meta.icon
                    const isExpanded   = expandedId === tool.id
                    const globalFields = MOVED_CONFIG_TOOL_IDS.has(tool.id)
                      ? []
                      : (tool.configSchema ?? []).filter(f => f.scope === 'global' || f.scope === 'both')
                    const hasConfig    = globalFields.length > 0 || MOVED_CONFIG_TOOL_IDS.has(tool.id)

                    return (
                      <Card key={tool.id} variant="surface" className="border-border/60">
                        <div className="flex items-center gap-3 px-4 py-3">
                          <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-card', meta.chip)}>
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
                            <Button type="button" variant="outline" size="sm" onClick={() => handleExpand(tool.id)}
                              className={cn('shrink-0 gap-1.5',
                                isExpanded ? 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand' : 'text-muted-foreground')}>
                              <Settings2 className="size-3" />
                              {isExpanded ? 'Done' : globalFields.length > 0 ? 'Config' : 'Manage'}
                            </Button>
                          )}
                          {/* Install state is read-only here: the App Store is the one
                              writer of the install flag (feature-backed tools go through
                              the orchestrator there). This panel keeps config + grants. */}
                          {!tool.core && (
                            <Link to={`/app-store/app/${tool.id}`} className="shrink-0" title="Manage in App Store">
                              <Badge variant={tool.enabled ? 'success' : 'outline'}>{tool.enabled ? 'Installed' : 'Not installed'}</Badge>
                            </Link>
                          )}
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
                                            className="w-full rounded-control border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand/40 pr-8" />
                                          {isSecret && (
                                            <button type="button" onClick={() => setShowSecret(prev => ({ ...prev, [fk]: !visible }))}
                                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors">
                                              {visible ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                                            </button>
                                          )}
                                        </div>
                                        {isDirty && (
                                          <Button type="button" size="sm" disabled={savingField[fk]}
                                            onClick={() => saveConfigField(tool.id, field.key, draftVal!)}
                                            className="shrink-0">
                                            {savingField[fk] ? '…' : 'Save'}
                                          </Button>
                                        )}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                            {configLoaded && users.length > 0 && (
                              <div className="space-y-2">
                                <p className="text-overline text-muted-foreground/60">Who can use this</p>
                                <div className="flex flex-wrap gap-2">
                                  {users.map(u => {
                                    const pk     = `${tool.id}.${u.id}`
                                    const denied = permissions[tool.id]?.[u.id] === 'deny'
                                    return (
                                      <button key={u.id} type="button" disabled={savingPerm[pk]}
                                        onClick={() => togglePerm(tool.id, u.id)}
                                        className={cn('flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors',
                                          denied ? 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20'
                                            : 'border-success/30 bg-success/10 text-success hover:bg-success/20',
                                          savingPerm[pk] && 'opacity-50')}>
                                        {u.nickname || u.firstName}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            )}
                            {MOVED_CONFIG_TOOL_IDS.has(tool.id) && (
                              <p className="text-[11px] text-muted-foreground/60">
                                Config for this app now lives on its own settings page.
                              </p>
                            )}
                          </div>
                        )}
                      </Card>
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

// Where each feature switch's "Choose models and extras" link points further down the page.
const FEATURE_DETAILS_ANCHOR: Record<string, string> = {
  coding: 'section-coding',
  image_gen: 'section-images',
  voice: 'section-voice',
  music_studio: 'section-capabilities',
  web_search: 'section-capabilities',
  reference: 'section-capabilities',
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
  const featureSwitches = useFeatureSwitches()
  // Automatic resource mode overrides the pinned chat model, so the swap/active UI
  // below needs an honest banner (a swap here downloads + pins, which automatic
  // ignores). Null until loaded; banner renders only when known-automatic.
  const [autoResources, setAutoResources] = useState<boolean | null>(null)
  useEffect(() => {
    fetch('/api/admin/gpu/resource-mode', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m) setAutoResources(m.mode === 'automatic') })
      .catch(() => {})
  }, [])

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

  if (loading) return <div className="px-5 py-6"><SkeletonListRows count={6} /></div>
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
  const codingModels = tierModels.filter(m => m.role === 'coding')

  const ollamaState = installStates.get('ollama-runtime')

  return (
    <div>
      {/* Header */}
      <div className="px-5 pt-5 pb-4 border-b border-border/40 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-title">Your AI</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {catalog.hardware.totalRamGb} GB{catalog.hardware.isAppleSilicon ? ' Apple Silicon' : ''} · {fmtCatalogBytes(catalog.disk.freeBytes)} free
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={loadAll}
            className="gap-1.5 text-muted-foreground shrink-0">
            <RefreshCw className="size-3" /> Refresh
          </Button>
        </div>

        {catalog.tiers.length > 1 && (
          <div className="space-y-1.5">
            <label className="block text-overline text-muted-foreground">Model size</label>
            <select value={selectedTier} onChange={e => setSelectedTier(e.target.value)}
              className="w-full rounded-control border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40">
              {catalog.tiers.map(t => (
                <option key={t.id} value={t.id}>{t.label}{t.id === catalog.recommendedTier ? ' (recommended for you)' : ''}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground/60">Bigger sizes are smarter but use more memory and respond a little slower.</p>
          </div>
        )}
      </div>

      <div className="px-5 py-6 space-y-8 pb-[600px]">

        {/* One-switch features: the primary way to turn a capability on or off. The
            sections further down hold the advanced knobs (model choice, extras). */}
        {(featureSwitches.data?.features.length ?? 0) > 0 && (
          <div id="section-switches" className="space-y-2">
            <p className="text-overline text-muted-foreground/60">Features</p>
            <p className="text-xs text-muted-foreground">
              One switch per feature. Everything each one needs (models, components) installs automatically in the background.
            </p>
            <div className="space-y-4 pt-1">
              {featureSwitches.data!.features.map((f) => {
                const busy =
                  (featureSwitches.enable.isPending && featureSwitches.enable.variables === f.id) ||
                  (featureSwitches.disable.isPending && featureSwitches.disable.variables === f.id) ||
                  (featureSwitches.repair.isPending && featureSwitches.repair.variables === f.id)
                return (
                  <FeatureSwitchRow
                    key={f.id}
                    feature={f}
                    freeBytes={featureSwitches.data!.disk.freeBytes || null}
                    busy={busy}
                    onEnable={() => featureSwitches.enable.mutate(f.id)}
                    onDisable={() => featureSwitches.disable.mutate(f.id)}
                    onRepair={() => featureSwitches.repair.mutate(f.id)}
                    onApprovePart={(cid) => void repairComponent(cid, cid)}
                    approvingIds={new Set([...installStates].filter(([, s]) => s.status === 'downloading').map(([id]) => id))}
                    detailsAnchor={FEATURE_DETAILS_ANCHOR[f.id]}
                  />
                )
              })}
            </div>
          </div>
        )}

        {/* Chat & Intelligence */}
        <div id="section-chat" className="space-y-2">
          <p className="text-overline text-muted-foreground/60">Chat &amp; Intelligence</p>

          {/* Ollama runtime row */}
          <Card variant="surface" className={cn('transition-colors', catalog.ollamaRunning ? 'border-success/30' : 'border-border')}>
            <div className="flex items-center gap-3 px-4 py-3">
              <div className={cn('flex size-5 shrink-0 items-center justify-center rounded-full', catalog.ollamaRunning ? 'bg-success/10' : 'bg-muted')}>
                {ollamaState?.status === 'downloading'
                  ? <Spinner size="sm" className="size-3" />
                  : catalog.ollamaRunning
                  ? <CheckCircle2 className="size-3 text-success" />
                  : <StatusDot status="off" />}
              </div>
              <Server className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <span className="text-overline text-muted-foreground">Runtime</span>
                <p className="text-sm font-semibold leading-tight">
                  {catalog.ollamaRunning ? 'Ollama · running' : 'Ollama'}
                  {catalog.ollamaVersion && <span className="ml-1.5 font-normal text-muted-foreground">v{catalog.ollamaVersion}</span>}
                </p>
                <p className="text-[11px] text-muted-foreground/70">Auto-checked weekly, upgrades itself when installed via Homebrew</p>
              </div>
              <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">~{fmtCatalogBytes(catalog.ollamaInstallBytes)}</span>
              <div className="shrink-0">
                {ollamaState?.status === 'downloading' ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => cancelInstall('ollama-runtime')}
                    className="px-2 text-muted-foreground">Cancel</Button>
                ) : catalog.ollamaRunning ? (
                  <span className="flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold text-success bg-success/10">
                    <CheckCircle2 className="size-2.5" /> Running
                  </span>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => void repairComponent('ollama-runtime', 'ollama-runtime')}
                    className="gap-1 px-2 text-muted-foreground">
                    <Download className="size-3" /> Install
                  </Button>
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
          </Card>

          {autoResources === true && (
            <div className="rounded-card border border-brand/30 bg-brand/10 px-4 py-3 flex items-start gap-3">
              <Bot className="size-4 shrink-0 text-brand mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-brand">Chat model is managed automatically</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  The active model is chosen to fit your hardware for best performance. Installing another model
                  here downloads it for automatic to use, but the pick stays automatic. To pin a specific model,
                  switch Resource management to Manual under System &gt; AI engine.
                </p>
              </div>
            </div>
          )}
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
            <div className="rounded-card border border-brand/30 bg-brand/10 px-4 py-3 flex items-start gap-3">
              <Eye className="size-4 shrink-0 text-brand mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-brand">Vision built in</p>
                <p className="text-xs text-muted-foreground mt-0.5">{activeTierLlm.label} understands images natively, no separate vision model needed.</p>
              </div>
            </div>
          )}
        </div>

        {/* Image Generation */}
        {imageModels.length > 0 && (
          <div id="section-images" className="space-y-2">
            <p className="text-overline text-muted-foreground/60">Image Generation</p>

            <div className="flex items-center gap-3 rounded-card border border-border/50 bg-muted/30 px-4 py-2.5">
              <Server className="size-4 shrink-0 text-muted-foreground/60" />
              <div className="min-w-0 flex-1">
                <span className="text-overline text-muted-foreground/60">Runtime</span>
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
          </div>
        )}

        {/* Voice */}
        {voiceModels.length > 0 && (
          <div id="section-voice" className="space-y-2">
            <p className="text-overline text-muted-foreground/60">Voice</p>
            {voiceModels.map(m => (
              <ModelInstallRow key={m.id} entry={m}
                installState={installStates.get(m.id)}
                onInstall={() => installEntry(m)}
                onCancel={() => cancelInstall(m.id)}
              />
            ))}
          </div>
        )}

        {codingModels.length > 0 && (
          <div id="section-coding" className="space-y-2">
            <p className="text-overline text-muted-foreground/60">Coding</p>
            <CapInstallRow
              cap={ADMIN_CAPS.find(c => c.id === 'claude-code')!}
              installed={compMap.get('claude-code') === true}
              installState={installStates.get('claude-code')}
              onInstall={() => void repairComponent('claude-code', 'claude-code')}
              onCancel={() => cancelInstall('claude-code')}
            />
            {catalog.hardware.platform === 'win32' ? (
              <div className="flex items-center gap-3 rounded-card border border-border/60 bg-card px-4 py-3 text-xs text-muted-foreground">
                <ShieldCheck className="size-4 shrink-0" />
                Split-pane multiplexing (tmux) isn't available on Windows. The coding terminal runs as a single persistent pane.
              </div>
            ) : (
              <CapInstallRow
                cap={ADMIN_CAPS.find(c => c.id === 'tmux')!}
                installed={compMap.get('tmux') === true}
                blocked={compMap.get('claude-code') !== true}
                installState={installStates.get('tmux')}
                onInstall={() => void repairComponent('tmux', 'tmux')}
                onCancel={() => cancelInstall('tmux')}
              />
            )}
            <CapInstallRow
              cap={ADMIN_CAPS.find(c => c.id === 'coding-sandbox-user')!}
              installed={compMap.get('coding-sandbox-user') === true}
              blocked={compMap.get('claude-code') !== true}
              installState={installStates.get('coding-sandbox-user')}
              onInstall={() => void repairComponent('coding-sandbox-user', 'coding-sandbox-user')}
              onCancel={() => cancelInstall('coding-sandbox-user')}
            />
            {codingModels.map(m => (
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
          <p className="text-overline text-muted-foreground/60">Base Applications</p>
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
          <p className="text-overline text-muted-foreground/60">More Capabilities</p>
          <p className="px-1 text-xs text-muted-foreground/70 -mt-1">Optional: add these at any time.</p>
          {ADMIN_CAPS.filter(c => !c.base && c.id !== 'claude-code' && c.id !== 'tmux' && c.id !== 'coding-sandbox-user' && c.id !== 'nvidia-gpu-tuning').map(cap => (
            <CapInstallRow key={cap.id} cap={cap}
              installed={compMap.get(cap.id) === true}
              blocked={cap.requires.some(r => compMap.get(r) !== true)}
              installState={installStates.get(cap.id)}
              onInstall={() => void repairComponent(cap.id, cap.id)}
              onCancel={() => cancelInstall(cap.id)}
            />
          ))}
          {catalog.hardware.platform === 'win32' && catalog.hardware.gpuVendor === 'nvidia' && (
            <CapInstallRow
              cap={ADMIN_CAPS.find(c => c.id === 'nvidia-gpu-tuning')!}
              installed={compMap.get('nvidia-gpu-tuning') === true}
              installState={installStates.get('nvidia-gpu-tuning')}
              onInstall={() => void repairComponent('nvidia-gpu-tuning', 'nvidia-gpu-tuning')}
              onCancel={() => cancelInstall('nvidia-gpu-tuning')}
            />
          )}
        </div>

      </div>

      <Dialog open={showFaceIdNotice} onOpenChange={open => { if (!open) { setShowFaceIdNotice(false); setPendingEntry(null) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Face Identity</DialogTitle>
            <DialogDescription className="sr-only">Privacy notice for face analysis models</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-foreground leading-relaxed">
            Face Identity models extract facial geometry from photos to inject your likeness into generated images. Only use this on photos you own or have explicit rights to process. All analysis happens locally; no images are sent externally.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => { setShowFaceIdNotice(false); setPendingEntry(null) }}
              className="text-muted-foreground">
              Cancel
            </Button>
            <Button type="button" size="sm"
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
              }}>
              Got it, install
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
