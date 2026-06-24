import { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react'
import { Sparkles, Settings2, X, RefreshCw, Wand2, ChevronDown, ChevronUp, Download, Trash2, Upload, Eraser, ZoomIn, Zap, Pencil, ArrowLeftRight, ScanFace, ImageOff, Maximize2, Palette, SlidersHorizontal, Aperture, ScanLine, Car, Search, ArrowRight, Loader2, FileText, MapPin, Eye, Type, Layers, Copy, Sparkle } from 'lucide-react'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useImageEdit } from '@/hooks/useImageEdit'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { PageShell } from '@/components/shared/PageShell'
import { ChromeWash } from '@/components/shared/ChromeWash'
import { cn } from '@/lib/cn'
import { useGenerationContext } from '@/context/GenerationContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { usePrivacy } from '@/context/PrivacyContext'
import { useImageAnalyze } from '@/hooks/useImageAnalyze'
import type { AnalysisTask, AnalysisHistoryItem, SafetyFlag } from '@/hooks/useImageAnalyze'

// ── Types ─────────────────────────────────────────────────────────────────────

const ANALYSIS_TASKS: { id: AnalysisTask; label: string; description: string; icon: React.ElementType; cardGrad: string }[] = [
  { id: 'description', label: 'Description', description: 'Natural language summary of the image',              icon: FileText, cardGrad: 'linear-gradient(135deg,#6366f1,#4f46e5)' },
  { id: 'scene',       label: 'Scene',       description: 'Identify the location or setting',                   icon: MapPin,   cardGrad: 'linear-gradient(135deg,#10b981,#059669)' },
  { id: 'objects',     label: 'Objects',     description: 'Detect people, pets, and other objects',             icon: Eye,      cardGrad: 'linear-gradient(135deg,#f59e0b,#d97706)' },
  { id: 'text',        label: 'Text / OCR',  description: 'Read visible text including license plates',         icon: Type,     cardGrad: 'linear-gradient(135deg,#0ea5e9,#0284c7)' },
  { id: 'vehicles',    label: 'Vehicles',    description: 'Identify vehicles, brands (FedEx/USPS), and plates', icon: Car,      cardGrad: 'linear-gradient(135deg,#ec4899,#db2777)' },
]

interface LoraOption {
  id: string
  name: string
  description: string | null
  triggerTokens: string[]
  defaultWeight: number
  thumbnailUrl: string | null
  styleLabel: string | null
  isAdult: boolean
}

interface HistoryItem {
  id: string
  prompt: string
  width: number
  height: number
  state: string
  pipeline: string
  loraIds: string | null
  isAdult: boolean
  createdAt: string | number
}

// ── Aspect ratio presets ───────────────────────────────────────────────────────

const ASPECT_PRESETS = [
  { label: '1:1',  width: 1024, height: 1024 },
  { label: '2:3',  width: 680,  height: 1024 },
  { label: '3:4',  width: 768,  height: 1024 },
  { label: '9:16', width: 576,  height: 1024 },
  { label: '3:2',  width: 1024, height: 680  },
  { label: '4:3',  width: 1024, height: 768  },
  { label: '16:9', width: 1024, height: 576  },
] as const

// ── Edit operations ────────────────────────────────────────────────────────────

const EDIT_OPERATIONS = [
  { id: 'enhance',       label: 'Enhance',           description: 'Sharpen details and improve quality — adjustable strength',      icon: Zap,               group: 'Enhance'   as const, cardGrad: 'linear-gradient(135deg,#f59e0b,#ef4444)' },
  { id: 'auto-color',    label: 'Auto Color',        description: 'Auto levels and vibrance — instant, no model needed',            icon: Palette,           group: 'Enhance'   as const, cardGrad: 'linear-gradient(135deg,#ec4899,#f43f5e)' },
  { id: 'adjust',        label: 'Adjust',            description: 'Brightness, contrast, saturation, and sharpness controls',       icon: SlidersHorizontal, group: 'Enhance'   as const, cardGrad: 'linear-gradient(135deg,#6366f1,#4f46e5)' },
  { id: 'remove-bg',     label: 'Remove BG',         description: 'Isolate the subject by cutting out the background',              icon: Eraser,            group: 'Transform' as const, cardGrad: 'linear-gradient(135deg,#7c3aed,#a855f7)' },
  { id: 'bg-blur',       label: 'BG Blur',           description: 'Keep the subject sharp while blurring the background',           icon: Aperture,          group: 'Transform' as const, cardGrad: 'linear-gradient(135deg,#0ea5e9,#06b6d4)' },
  { id: 'upscale',       label: 'Upscale 4×',        description: 'Increase resolution 4× with AI upscaling (ESRGAN)',              icon: ZoomIn,            group: 'Transform' as const, cardGrad: 'linear-gradient(135deg,#10b981,#059669)' },
  { id: 'face-restore',  label: 'Face Restore',      description: 'Repair blurry, old, or AI-generated faces (CodeFormer / GFPGAN)', icon: ScanFace,        group: 'Restore'   as const, cardGrad: 'linear-gradient(135deg,#8b5cf6,#6d28d9)' },
  { id: 'photo-restore', label: 'Old Photo',         description: 'Repair damage, enhance faces, and upscale old or degraded photos', icon: ImageOff,       group: 'Restore'   as const, cardGrad: 'linear-gradient(135deg,#f97316,#dc2626)' },
]

// ── Sidebar nav ───────────────────────────────────────────────────────────────

type ActiveTab = 'generate' | 'edit' | 'recognize' | 'logo'

const NAV_ITEMS: { id: ActiveTab; icon: React.ElementType; label: string }[] = [
  { id: 'generate',  icon: Sparkles, label: 'Generate' },
  { id: 'edit',      icon: Wand2,    label: 'Edit'     },
  { id: 'recognize', icon: ScanFace, label: 'Recognize'},
  { id: 'logo',      icon: Layers,   label: 'Logo'     },
]

// ── Generation progress display ────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`
}

function GenProgress({ step, total, elapsedMs }: { step: number; total: number; elapsedMs: number }) {
  const [wallMs, setWallMs] = useState(0)
  useEffect(() => {
    if (step > 0) return
    const t0 = Date.now()
    const id = setInterval(() => setWallMs(Date.now() - t0), 1000)
    return () => clearInterval(id)
  }, [step])

  // Track elapsedMs at first step so ETA excludes queue/model-load overhead
  const firstStepElapsedRef = useRef<number | null>(null)
  if (step > 0 && firstStepElapsedRef.current === null) firstStepElapsedRef.current = elapsedMs

  const pct = total > 0 ? Math.round((step / total) * 100) : 0

  const etaLabel = (() => {
    if (step <= 0 || total <= 0 || step >= total) return null
    const samplingElapsed = elapsedMs - (firstStepElapsedRef.current ?? elapsedMs)
    if (samplingElapsed <= 0 || step <= 1) return null
    const msPerStep = samplingElapsed / step
    const remainingMs = msPerStep * (total - step)
    return `~${formatDuration(remainingMs)} left`
  })()

  const finalizing = step > 0 && step >= total
  const startingLabel = step === 0
    ? (wallMs > 15_000 ? `Loading model… ${formatDuration(wallMs)}` : 'Starting…')
    : finalizing
      ? `Finalizing… · ${formatDuration(elapsedMs)}`
      : `${step}/${total} steps · ${formatDuration(elapsedMs)}`

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6">
      <div className="w-full max-w-xs">
        <div className="h-1.5 w-full rounded-full bg-black/40 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.max(4, pct)}%`,
              background: 'linear-gradient(90deg, #6366f1, #ec4899)',
            }}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-white/70">
          <span>{startingLabel}</span>
          {etaLabel && <span>{etaLabel}</span>}
        </div>
      </div>
      <p className="text-sm text-white/60 animate-pulse">Generating…</p>
    </div>
  )
}

// ── Fullscreen lightbox ───────────────────────────────────────────────────────

function Lightbox({ src, prompt, onClose }: { src: string; prompt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      <img
        src={src}
        alt={prompt ?? ''}
        className="max-w-full max-h-full object-contain select-none"
        onClick={e => e.stopPropagation()}
      />
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-black/60 hover:bg-black/80 text-white transition-colors"
        title="Close"
      >
        <X className="size-5" />
      </button>
      {prompt && (
        <div className="absolute bottom-0 inset-x-0 pointer-events-none">
          <div className="bg-gradient-to-t from-black/80 to-transparent px-6 pt-10 pb-5">
            <p className="text-sm text-white/75 text-center max-w-3xl mx-auto line-clamp-3 leading-relaxed">{prompt}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Result image ──────────────────────────────────────────────────────────────

function ResultImage({ src, prompt, onDelete, onFullscreen }: { src: string; prompt: string; onDelete?: () => void; onFullscreen?: () => void }) {
  const [loaded, setLoaded] = useState(false)

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = src
    a.download = `image-${src.split('/').pop()?.slice(0, 8) ?? 'download'}.png`
    a.click()
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center group">
      <img
        src={src}
        alt={prompt}
        onLoad={() => setLoaded(true)}
        className={cn(
          'max-w-full max-h-full object-contain rounded-xl transition-opacity duration-500',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="size-8 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
        </div>
      )}
      {loaded && (
        <div className="absolute bottom-3 right-3 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onFullscreen && (
            <button
              onClick={onFullscreen}
              className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white transition-colors"
              title="Fullscreen"
            >
              <Maximize2 className="size-4" />
            </button>
          )}
          <button
            onClick={handleDownload}
            className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white transition-colors"
            title="Download"
          >
            <Download className="size-4" />
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1.5 rounded-md bg-black/60 hover:bg-red-600/80 text-white transition-colors"
              title="Delete"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Before/after compare slider ───────────────────────────────────────────────

function CompareSlider({ beforeSrc, afterSrc }: { beforeSrc: string; afterSrc: string }) {
  const [position, setPosition] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const updatePosition = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const pct = Math.max(2, Math.min(98, ((clientX - rect.left) / rect.width) * 100))
    setPosition(pct)
  }, [])

  useLayoutEffect(() => {
    const onMove = (e: MouseEvent) => { if (dragging.current) updatePosition(e.clientX) }
    const onUp = () => { dragging.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [updatePosition])

  return (
    <div ref={containerRef} className="relative w-full h-full select-none">
      <img src={afterSrc} alt="After" className="absolute inset-0 w-full h-full object-contain" />
      <img
        src={beforeSrc}
        alt="Before"
        className="absolute inset-0 w-full h-full object-contain"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      />
      <div className="absolute top-0 bottom-0 w-0.5 bg-white/80 shadow pointer-events-none" style={{ left: `${position}%` }} />
      <button
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-8 rounded-full bg-white shadow-lg flex items-center justify-center cursor-col-resize z-10"
        style={{ left: `${position}%` }}
        onMouseDown={e => { dragging.current = true; e.preventDefault() }}
        onTouchMove={e => updatePosition(e.touches[0].clientX)}
        onTouchStart={e => e.preventDefault()}
        aria-label="Drag to compare"
      >
        <ArrowLeftRight className="size-3.5 text-gray-600" />
      </button>
      <div className="absolute bottom-3 left-3 rounded px-1.5 py-0.5 text-xs bg-black/50 text-white pointer-events-none">Before</div>
      <div className="absolute bottom-3 right-3 rounded px-1.5 py-0.5 text-xs bg-black/50 text-white pointer-events-none">After</div>
    </div>
  )
}


// ── Ratio icon ────────────────────────────────────────────────────────────────

function RatioIcon({ ratioW, ratioH }: { ratioW: number; ratioH: number }) {
  const MAX = 20
  const aspect = ratioW / ratioH
  const bw = aspect >= 1 ? MAX : Math.round(MAX * aspect)
  const bh = aspect >= 1 ? Math.round(MAX / aspect) : MAX
  return (
    <div
      className="rounded-sm border-[1.5px] border-current"
      style={{ width: bw, height: bh }}
    />
  )
}

// ── LoRA picker (visual grid) ─────────────────────────────────────────────────

function LoraPicker({
  loras,
  selected,
  onToggle,
}: {
  loras: LoraOption[]
  selected: Set<string>
  onToggle: (id: string) => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')

  const filtered = query.trim() === ''
    ? loras
    : loras.filter(l => {
        const q = query.toLowerCase()
        return l.name.toLowerCase().includes(q)
          || (l.styleLabel ?? '').toLowerCase().includes(q)
          || (l.description ?? '').toLowerCase().includes(q)
      })

  const submit = () => setQuery(searchInput)
  const clear = () => { setSearchInput(''); setQuery('') }

  if (loras.length === 0) return null

  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold">Styles</Label>
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
          <Input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="Search styles…"
            className="h-7 pl-7 pr-6 text-xs rounded-lg"
          />
          {searchInput && (
            <button onClick={clear} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          )}
        </div>
        <button
          onClick={submit}
          className="flex items-center justify-center size-7 rounded-lg bg-muted hover:bg-muted/80 active:scale-95 text-muted-foreground hover:text-foreground transition-all shrink-0"
          title="Search"
        >
          <ArrowRight className="size-3.5" />
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2 text-center">No styles match "{query}"</p>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {filtered.map(l => (
            <div
              key={l.id}
              className="relative"
              onMouseEnter={() => setHoveredId(l.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <button
                onClick={() => onToggle(l.id)}
                className={cn(
                  'flex flex-col items-center gap-1 w-full rounded-xl border-2 p-1 transition-colors',
                  selected.has(l.id)
                    ? 'border-brand'
                    : 'border-transparent hover:border-border',
                )}
              >
                {l.thumbnailUrl ? (
                  <img src={l.thumbnailUrl} alt="" className="w-full aspect-square rounded-lg object-cover" />
                ) : (
                  <div className="w-full aspect-square rounded-lg bg-muted flex items-center justify-center">
                    <Palette className="size-5 text-muted-foreground" />
                  </div>
                )}
                <span className="text-[10px] text-center leading-tight truncate w-full px-0.5">
                  {l.styleLabel ?? l.name}
                </span>
              </button>

              {hoveredId === l.id && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 rounded-xl bg-zinc-900 border border-white/10 shadow-2xl z-50 overflow-hidden pointer-events-none">
                  {l.thumbnailUrl && (
                    <img src={l.thumbnailUrl} alt="" className="w-full aspect-[3/4] object-cover" />
                  )}
                  <div className="p-2.5 space-y-1">
                    <p className="text-[11px] font-semibold text-white leading-tight">{l.name}</p>
                    {l.description && (
                      <p className="text-[10px] text-white/50 leading-snug line-clamp-4">{l.description}</p>
                    )}
                    {l.triggerTokens.length > 0 && (
                      <p className="text-[10px] text-sky-400/70 font-mono leading-tight">{l.triggerTokens.join(', ')}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── History tile ──────────────────────────────────────────────────────────────

function HistoryTile({ item, onClick, onDelete, onEdit, onFullscreen, selected }: { item: HistoryItem; onClick: () => void; onDelete?: () => void; onEdit?: () => void; onFullscreen?: () => void; selected?: boolean }) {
  const [imgLoaded, setImgLoaded] = useState(false)

  if (item.state !== 'ready') {
    return (
      <div className="aspect-square rounded-xl bg-muted flex items-center justify-center">
        <div className="size-4 rounded-full border border-muted-foreground/30 border-t-muted-foreground animate-spin" />
      </div>
    )
  }

  const handleDownload = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    const a = document.createElement('a')
    a.href = `/api/image/artifacts/${item.id}`
    a.download = `image-${item.id.slice(0, 8)}.png`
    a.click()
  }

  const handleDelete = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    onDelete?.()
  }

  return (
    <div className={cn(
      'relative aspect-square rounded-xl overflow-hidden bg-muted group',
      selected && 'ring-2 ring-brand',
    )}>
      <button
        onClick={onClick}
        className="absolute inset-0 hover:ring-2 hover:ring-brand transition-all"
      >
        <img
          src={`/api/image/artifacts/${item.id}`}
          alt={item.prompt}
          loading="lazy"
          onLoad={() => setImgLoaded(true)}
          className={cn('w-full h-full object-cover transition-opacity duration-300', imgLoaded ? 'opacity-100' : 'opacity-0')}
        />
      </button>
      {item.prompt && (
        <div className="absolute bottom-0 inset-x-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          <div className="bg-gradient-to-t from-black/80 to-transparent px-1.5 pt-5 pb-5">
            <p className="text-[9px] text-white/85 line-clamp-2 leading-tight">{item.prompt}</p>
          </div>
        </div>
      )}
      {(onDelete || onEdit || onFullscreen) && (
        <div className="absolute bottom-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onEdit && (
            <button
              onClick={e => { e.stopPropagation(); onEdit() }}
              className="p-1 rounded bg-black/60 hover:bg-indigo-600/80 text-white transition-colors"
              title="Edit"
            >
              <Pencil className="size-3" />
            </button>
          )}
          {onFullscreen && (
            <button
              onClick={e => { e.stopPropagation(); onFullscreen() }}
              className="p-1 rounded bg-black/60 hover:bg-black/80 text-white transition-colors"
              title="Fullscreen"
            >
              <Maximize2 className="size-3" />
            </button>
          )}
          <button
            onClick={handleDownload}
            className="p-1 rounded bg-black/60 hover:bg-black/80 text-white transition-colors"
            title="Download"
          >
            <Download className="size-3" />
          </button>
          {onDelete && (
            <button
              onClick={handleDelete}
              className="p-1 rounded bg-black/60 hover:bg-red-600/80 text-white transition-colors"
              title="Delete"
            >
              <Trash2 className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ImagingPage() {
  const { imaging } = useGenerationContext()
  const { state: gen, generate, cancel, reset } = imaging
  const [pending, setPending] = useState(false)
  const { enabled: privacyEnabled, adultVisible } = usePrivacy()
  const { analyze, status: analyzeStatus, result: analyzeResult, error: analyzeError, reset: analyzeReset } = useImageAnalyze()

  // On mount: detect any orphaned or mis-flagged building job and reconnect/correct it
  useEffect(() => {
    interface BuildingJob { id: string; pipeline: string; isAdult: boolean; prompt: string | null; steps: number }
    const currentStatus = gen.status
    const currentImageId = gen.imageId
    fetch('/api/image/building', { credentials: 'include' })
      .then(r => r.ok ? (r.json() as Promise<BuildingJob | null>) : null)
      .then(d => {
        if (!d || d.pipeline === 'video' || d.pipeline === 'i2v') return
        if (currentStatus === 'idle') {
          imaging.reconnect(d.id, d.steps, d.isAdult, d.prompt)
        } else if (currentStatus === 'generating' && currentImageId === d.id) {
          imaging.setIsAdult(d.isAdult)
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Generation state ───────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('generate')
  const [prompt, setPrompt] = useState(() => imaging.state.status === 'generating' ? (imaging.activePrompt ?? '') : '')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [aspectPreset, setAspectPreset] = useState(0)
  const [steps, setSteps] = useState(20)
  const [guidance, setGuidance] = useState(3.5)
  const [seed, setSeed] = useState(-1)
  const [selectedLoras, setSelectedLoras] = useState<Set<string>>(() =>
    imaging.state.status === 'generating' && imaging.activeLoraIds ? new Set(imaging.activeLoraIds) : new Set()
  )
  const [sentLoraInfo, setSentLoraInfo] = useState<LoraOption[]>([])
  const [sentLoraWeights, setSentLoraWeights] = useState<Record<string, number>>({})
  // Mirror the sent-LoRA state into refs so the auto-mode preview-check effect
  // reads current values without re-subscribing (avoids a stale closure that
  // would post outdated LoRA weights to /api/image/preview-check).
  const sentLoraInfoRef = useRef(sentLoraInfo)
  sentLoraInfoRef.current = sentLoraInfo
  const sentLoraWeightsRef = useRef(sentLoraWeights)
  sentLoraWeightsRef.current = sentLoraWeights
  const [autoMode, setAutoMode] = useState(true)
  const [autoPhase, setAutoPhase] = useState<'idle' | 'checking' | 'correcting' | 'blocked'>('idle')
  const autoCheckFiredRef = useRef(false)
  const lastGenParamsRef = useRef<{ params: Parameters<typeof generate>[0]; isAdult: boolean } | null>(null)
  // Tracks whether the component is still mounted, so the history loaders
  // (which can resolve after navigation away) don't setState after unmount.
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  const [paramsOpen, setParamsOpen] = useState(false)
  const [loras, setLoras] = useState<LoraOption[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [editHistory, setEditHistory] = useState<HistoryItem[]>([])
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)
  const [selectedEditHistoryId, setSelectedEditHistoryId] = useState<string | null>(null)
  const [imageGenAvailable, setImageGenAvailable] = useState<boolean | null>(null)
  const [imageGenState, setImageGenState] = useState<'ready' | 'warming' | 'offline' | 'not_installed' | null>(null)
  const [repairJob, setRepairJob] = useState<{ label: string; pct: number | null } | null>(null)
  const [codeformerAvailable, setCodeformerAvailable] = useState(false)
  const [gfpganAvailable, setGfpganAvailable] = useState(false)
  const [faceRestoreNodeAvailable, setFaceRestoreNodeAvailable] = useState(false)
  const [upscaleAvailableState, setUpscaleAvailableState] = useState(false)
  const [photoRestoreAvailable, setPhotoRestoreAvailable] = useState(false)

  // ── Recognition state ──────────────────────────────────────────────────────
  const [visionAvailable, setVisionAvailable] = useState<boolean | null>(null)
  const [recognizeFile, setRecognizeFile] = useState<File | null>(null)
  const [recognizePreview, setRecognizePreview] = useState<string | null>(null)
  const [selectedTasks, setSelectedTasks] = useState<Set<AnalysisTask>>(new Set())
  const [analyzeHistory, setAnalyzeHistory] = useState<AnalysisHistoryItem[]>([])
  const recognizeFileInputRef = useRef<HTMLInputElement>(null)
  const [recognizeDropOver, setRecognizeDropOver] = useState(false)

  const imagingContextDesc = useMemo(() => {
    const tab = activeTab === 'generate' ? 'image generation' : activeTab === 'edit' ? 'image editing' : 'image recognition'
    return prompt.trim()
      ? `User is on the Image Generation page, ${tab} tab, with prompt: "${prompt.trim()}".`
      : `User is on the Image Generation page, ${tab} tab.`
  }, [activeTab, prompt])
  usePublishUIContext({ label: 'Imaging', description: imagingContextDesc })

  // ── Editing state ──────────────────────────────────────────────────────────
  const { state: edit, run: runEdit, cancel: cancelEdit, reset: resetEdit, restore: restoreEdit } = useImageEdit()
  const [editSourceId, setEditSourceId] = useState<string | null>(null)
  const [editSourcePreview, setEditSourcePreview] = useState<string | null>(null)
  const [editSourceFile, setEditSourceFile] = useState<File | null>(null)
  const [editOp, setEditOp] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dropOver, setDropOver] = useState(false)
  const [fullscreenSrc, setFullscreenSrc] = useState<{ src: string; prompt: string } | null>(null)
  const [confirmDeleteImageId, setConfirmDeleteImageId] = useState<string | null>(null)
  const [confirmDeleteAnalysisId, setConfirmDeleteAnalysisId] = useState<string | null>(null)
  const [enhanceStrength, setEnhanceStrength] = useState(0.3)
  const [faceRestoreModel, setFaceRestoreModel] = useState<'codeformer' | 'gfpgan'>('codeformer')
  const [faceRestoreFidelity, setFaceRestoreFidelity] = useState(0.5)
  const [photoRestoreFaces, setPhotoRestoreFaces] = useState(true)
  const [photoRestoreUpscale, setPhotoRestoreUpscale] = useState(true)
  const [bgBlurRadius, setBgBlurRadius] = useState(15)
  const [adjBrightness, setAdjBrightness] = useState(0)
  const [adjContrast,   setAdjContrast]   = useState(0)
  const [adjSaturation, setAdjSaturation] = useState(0)
  const [adjSharpness,  setAdjSharpness]  = useState(0)

  useEffect(() => {
    return () => {
      if (editSourcePreview) URL.revokeObjectURL(editSourcePreview)
    }
  }, [editSourcePreview])

  // Restore edit session from sessionStorage on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('loki-edit-session')
      if (!saved) return
      const s = JSON.parse(saved) as {
        editSourceId?: string
        editOp?: string
        resultImageId?: string
        faceRestoreModel?: 'codeformer' | 'gfpgan'
        faceRestoreFidelity?: number
        enhanceStrength?: number
        activeTab?: 'generate' | 'edit'
      }
      if (s.editSourceId)        setEditSourceId(s.editSourceId)
      if (s.editOp)              setEditOp(s.editOp)
      if (s.faceRestoreModel)    setFaceRestoreModel(s.faceRestoreModel)
      if (s.faceRestoreFidelity != null) setFaceRestoreFidelity(s.faceRestoreFidelity)
      if (s.enhanceStrength != null)     setEnhanceStrength(s.enhanceStrength)
      if (s.activeTab)           setActiveTab(s.activeTab)
      if (s.resultImageId)       restoreEdit(s.resultImageId)
    } catch { /* ignore corrupt storage */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    try {
      sessionStorage.setItem('loki-edit-session', JSON.stringify({
        editSourceId,
        editOp,
        resultImageId: edit.status === 'done' ? edit.imageId : null,
        faceRestoreModel,
        faceRestoreFidelity,
        enhanceStrength,
        activeTab,
      }))
    } catch { /* ignore quota errors */ }
  }, [editSourceId, editOp, edit.status, edit.imageId, faceRestoreModel, faceRestoreFidelity, enhanceStrength, activeTab])

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()

    fetch('/api/image/loras', { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : [])
      .then((data: LoraOption[]) => { if (!cancelled) setLoras(data) })
      .catch(() => {})

    fetch('/api/image/status', { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : { ok: false })
      .then((data: { ok: boolean; state?: string; repairJob?: { label: string; pct: number | null } | null; codeformerAvailable?: boolean; gfpganAvailable?: boolean; faceRestoreNodeAvailable?: boolean; upscaleAvailable?: boolean; photoRestoreAvailable?: boolean }) => {
        if (cancelled) return
        setImageGenAvailable(data.ok)
        setImageGenState((data.state as 'ready' | 'warming' | 'offline' | 'not_installed') ?? (data.ok ? 'ready' : 'offline'))
        setRepairJob(data.repairJob ?? null)
        setCodeformerAvailable(data.codeformerAvailable ?? false)
        setGfpganAvailable(data.gfpganAvailable ?? false)
        setFaceRestoreNodeAvailable(data.faceRestoreNodeAvailable ?? false)
        setUpscaleAvailableState(data.upscaleAvailable ?? false)
        setPhotoRestoreAvailable(data.photoRestoreAvailable ?? false)
      })
      .catch(() => { if (!cancelled) { setImageGenAvailable(false); setImageGenState('offline') } })

    loadHistory(true)
    loadEditHistory()
    return () => { cancelled = true; ctrl.abort() }
  }, [])

  // Poll /api/image/status continuously while ComfyUI is installed:
  //   • 3s when warming or a repair job is active (need fast UI updates)
  //   • 10s when ready and idle (catches repair jobs that appear after page load,
  //     e.g. when a generation fails and triggers scanAndRepairCorruptImageModels)
  useEffect(() => {
    if (!imageGenState || imageGenState === 'not_installed' || imageGenState === 'offline') return
    let cancelled = false
    const ctrl = new AbortController()
    const pollStatus = () => {
      fetch('/api/image/status', { signal: ctrl.signal })
        .then(r => r.ok ? r.json() : { ok: false })
        .then((data: { ok: boolean; state?: string; repairJob?: { label: string; pct: number | null } | null }) => {
          if (cancelled) return
          setRepairJob(data.repairJob ?? null)
          if (data.state === 'ready' && !data.repairJob) {
            setImageGenAvailable(true)
            setImageGenState('ready')
          } else if (data.state === 'ready') {
            setImageGenState('ready')
          }
        })
        .catch(() => {})
    }
    const interval = (imageGenState === 'warming' || !!repairJob) ? 3_000 : 10_000
    const id = setInterval(pollStatus, interval)
    return () => { cancelled = true; ctrl.abort(); clearInterval(id) }
  }, [imageGenState, repairJob])

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()

    fetch('/api/vision/status', { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : { available: false })
      .then((data: { available: boolean }) => { if (!cancelled) setVisionAvailable(data.available) })
      .catch(() => { if (!cancelled) setVisionAvailable(false) })

    fetch('/api/vision/history?limit=12', { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : [])
      .then((data: AnalysisHistoryItem[]) => { if (!cancelled) setAnalyzeHistory(data) })
      .catch(() => {})
    return () => { cancelled = true; ctrl.abort() }
  }, [])

  useEffect(() => {
    return () => { if (recognizePreview) URL.revokeObjectURL(recognizePreview) }
  }, [recognizePreview])

  useEffect(() => {
    if (gen.status === 'done') {
      loadHistory()
      setSelectedHistoryId(gen.imageId)
      setAutoPhase('idle')
    }
    // Re-fetch status immediately on error so a repair job created by the failure
    // (scanAndRepairCorruptImageModels) is surfaced right away rather than waiting
    // for the next slow poll cycle.
    if (gen.status === 'error') {
      fetch('/api/image/status')
        .then(r => r.ok ? r.json() : null)
        .then((data: { ok: boolean; state?: string; repairJob?: { label: string; pct: number | null } | null } | null) => {
          if (!data) return
          setRepairJob(data.repairJob ?? null)
          setImageGenAvailable(data.ok)
        })
        .catch(() => {})
    }
  }, [gen.status, gen.imageId])

  // Auto mode: mid-generation preview check at ~28% steps
  useEffect(() => {
    if (!autoMode) return
    if (gen.status !== 'generating') return
    if (!gen.previewUrl) return
    if (autoCheckFiredRef.current) return
    if (gen.totalSteps === 0) return
    const checkAt = Math.max(5, Math.round(gen.totalSteps * 0.28))
    if (gen.step < checkAt) return

    autoCheckFiredRef.current = true
    const previewBase64 = gen.previewUrl.replace(/^data:image\/[^;]+;base64,/, '')
    const capturedImageId = gen.imageId

    ;(async () => {
      setAutoPhase('checking')
      try {
        const res = await fetch('/api/image/preview-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            prompt: lastGenParamsRef.current?.params.prompt ?? '',
            previewBase64,
            loras: sentLoraInfoRef.current.map(l => ({
              id: l.id,
              name: l.styleLabel ?? l.name,
              weight: sentLoraWeightsRef.current[l.id] ?? l.defaultWeight,
            })),
          }),
        })
        if (!res.ok) { setAutoPhase('idle'); return }
        const data = await res.json() as {
          match: boolean
          blocked?: boolean
          seen?: string
          correctedPrompt?: string
          correctedWeights?: Record<string, number>
        }

        // Safety veto — cancel the running job and stop. Do NOT retry/correct.
        if (data.blocked) {
          if (capturedImageId) cancel(capturedImageId)
          await new Promise(r => setTimeout(r, 300))
          reset()
          setAutoPhase('blocked')
          return
        }

        if (data.match) { setAutoPhase('idle'); return }

        // Mismatch — cancel and re-generate with corrections (one attempt only)
        setAutoPhase('correcting')
        if (capturedImageId) cancel(capturedImageId)

        const base = lastGenParamsRef.current
        if (!base) { setAutoPhase('idle'); return }

        const correctedPrompt = data.correctedPrompt ?? base.params.prompt
        const correctedWeights = data.correctedWeights && Object.keys(data.correctedWeights).length > 0
          ? data.correctedWeights
          : base.params.loraWeights

        if (correctedPrompt !== base.params.prompt) setPrompt(correctedPrompt)
        if (correctedWeights) setSentLoraWeights(correctedWeights)

        await new Promise(r => setTimeout(r, 600))
        reset()

        const correctedParams = { ...base.params, prompt: correctedPrompt, loraWeights: correctedWeights }
        lastGenParamsRef.current = { params: correctedParams, isAdult: base.isAdult }
        // autoCheckFiredRef stays true — no second check on the corrected run
        await generate(correctedParams, base.isAdult)
        setAutoPhase('idle')
      } catch {
        setAutoPhase('idle')
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen.step, gen.previewUrl, gen.status, gen.totalSteps, autoMode])

  useEffect(() => {
    if (edit.status === 'done') {
      loadEditHistory()
      setSelectedEditHistoryId(edit.imageId ?? null)
    }
  }, [edit.status, edit.imageId])

  const loadHistory = useCallback((autoSelect = false) => {
    fetch('/api/image/history?limit=24&kind=generated')
      .then(r => r.ok ? r.json() : [])
      .then((data: HistoryItem[]) => {
        if (!mountedRef.current) return
        const imageOnly = data.filter(h => h.pipeline !== 'video' && h.pipeline !== 'i2v')
        setHistory(imageOnly)
        if (autoSelect && imageOnly.length > 0) {
          setSelectedHistoryId(prev => prev ?? imageOnly[0].id)
        }
      })
      .catch(() => {})
  }, [])

  const loadEditHistory = useCallback(() => {
    fetch('/api/image/history?limit=24&kind=edited')
      .then(r => r.ok ? r.json() : [])
      .then((data: HistoryItem[]) => { if (mountedRef.current) setEditHistory(data) })
      .catch(() => {})
  }, [])

  const handleRecognizeFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setRecognizeFile(file)
    setRecognizePreview(URL.createObjectURL(file))
    analyzeReset()
    e.target.value = ''
  }, [analyzeReset])

  const onRecognizeDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setRecognizeDropOver(true) }, [])
  const onRecognizeDragLeave = useCallback(() => setRecognizeDropOver(false), [])
  const onRecognizeDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setRecognizeDropOver(false)
    const file = e.dataTransfer.files[0]
    if (!file?.type.startsWith('image/')) return
    setRecognizeFile(file)
    setRecognizePreview(URL.createObjectURL(file))
    analyzeReset()
  }, [analyzeReset])

  const toggleTask = useCallback((id: AnalysisTask) => {
    setSelectedTasks(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const loadAnalyzeHistory = useCallback(() => {
    fetch('/api/vision/history?limit=12')
      .then(r => r.ok ? r.json() : [])
      .then((data: AnalysisHistoryItem[]) => setAnalyzeHistory(data))
      .catch(() => {})
  }, [])

  const handleAnalyze = useCallback(async () => {
    if (!recognizeFile) return
    const tasks = selectedTasks.size > 0 ? Array.from(selectedTasks) : ANALYSIS_TASKS.map(t => t.id)
    await analyze(recognizeFile, tasks)
    loadAnalyzeHistory()
  }, [recognizeFile, selectedTasks, analyze, loadAnalyzeHistory])

  const handleDeleteAnalysis = useCallback(async (id: string) => {
    await fetch(`/api/vision/artifacts/${id}`, { method: 'DELETE', credentials: 'include' })
    setAnalyzeHistory(prev => prev.filter(a => a.id !== id))
  }, [])

  // ── Logo state ────────────────────────────────────────────────────────────────
  const [logoName, setLogoName] = useState('')
  const [logoTagline, setLogoTagline] = useState('')
  const [logoStyle, setLogoStyle] = useState<'wordmark' | 'abstract' | 'badge' | 'icon' | 'retro'>('wordmark')
  const [logoPrimaryColor, setLogoPrimaryColor] = useState('#6d28d9')
  const [logoAccentColor, setLogoAccentColor] = useState('#a78bfa')
  const [logoSvg, setLogoSvg] = useState<string | null>(null)
  const [logoLoading, setLogoLoading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [logoQualityLoading, setLogoQualityLoading] = useState(false)

  const handleLogoGenerate = useCallback(async () => {
    if (!logoName.trim() || logoLoading) return
    setLogoLoading(true)
    setLogoError(null)
    try {
      const r = await fetch('/api/logo/generate', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: logoName.trim(), tagline: logoTagline.trim() || undefined, style: logoStyle, primaryColor: logoPrimaryColor, accentColor: logoAccentColor }),
      })
      const d = await r.json() as { svg?: string; error?: string }
      if (d.error) setLogoError(d.error)
      else setLogoSvg(d.svg ?? null)
    } catch (err: any) {
      setLogoError(String(err?.message ?? 'Generation failed'))
    } finally {
      setLogoLoading(false)
    }
  }, [logoName, logoTagline, logoStyle, logoPrimaryColor, logoAccentColor, logoLoading])

  const handleLogoQuality = useCallback(async () => {
    if (!logoName.trim() || logoQualityLoading) return
    setLogoQualityLoading(true)
    try {
      const r = await fetch('/api/logo/quality-prompt', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: logoName.trim(), tagline: logoTagline.trim() || undefined, style: logoStyle, primaryColor: logoPrimaryColor }),
      })
      const d = await r.json() as { prompt?: string; negativePrompt?: string }
      if (d.prompt) {
        setActiveTab('generate')
        setPrompt(d.prompt)
      }
    } finally {
      setLogoQualityLoading(false)
    }
  }, [logoName, logoTagline, logoStyle, logoPrimaryColor, logoQualityLoading])

  function downloadLogoSvg() {
    if (!logoSvg) return
    const blob = new Blob([logoSvg], { type: 'image/svg+xml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${logoName || 'logo'}.svg`
    a.click()
  }

  function copyLogoSvg() {
    if (!logoSvg) return
    navigator.clipboard.writeText(logoSvg).catch(() => {})
  }

  function downloadLogoPng() {
    if (!logoSvg) return
    const blob = new Blob([logoSvg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 800; canvas.height = 800
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, 800, 800)
      URL.revokeObjectURL(url)
      canvas.toBlob(b => {
        if (!b) return
        const a = document.createElement('a')
        a.href = URL.createObjectURL(b)
        a.download = `${logoName || 'logo'}.png`
        a.click()
      })
    }
    img.src = url
  }

  const LOGO_STYLES = [
    { id: 'wordmark' as const, label: 'Wordmark' },
    { id: 'abstract' as const, label: 'Abstract' },
    { id: 'badge'    as const, label: 'Badge'    },
    { id: 'icon'     as const, label: 'Icon'     },
    { id: 'retro'    as const, label: 'Retro'    },
  ]
  // ─────────────────────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || gen.status === 'generating') return
    setPending(true)
    const loraIdList = Array.from(selectedLoras)
    const selectedLoraObjects = loras.filter(l => loraIdList.includes(l.id))

    let finalPrompt = prompt.trim()
    let loraWeights: Record<string, number> | undefined

    if (autoMode) {
      // Auto-enhance: LLM improves prompt specificity and suggests optimal LoRA weights
      try {
        const res = await fetch('/api/image/auto-enhance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            prompt: finalPrompt,
            loras: selectedLoraObjects.map(l => ({
              id: l.id,
              name: l.styleLabel ?? l.name,
              description: l.description,
              isStylisticLora: l.triggerTokens.length > 0 || l.styleLabel !== null,
            })),
          }),
        })
        if (res.ok) {
          const data = await res.json() as { prompt: string; weights: Record<string, number> }
          if (data.prompt) finalPrompt = data.prompt
          if (data.weights && Object.keys(data.weights).length > 0) loraWeights = data.weights
        }
      } catch { /* non-fatal — use original prompt + default weights */ }
    }

    if (finalPrompt !== prompt.trim()) setPrompt(finalPrompt)
    setSentLoraInfo(selectedLoraObjects)
    setSentLoraWeights(loraWeights ?? {})

    const preset = ASPECT_PRESETS[aspectPreset]
    reset()
    setSelectedHistoryId(null)
    const genIsAdult = selectedLoraObjects.some(l => l.isAdult)
    const genParams = {
      prompt: finalPrompt,
      negativePrompt: negativePrompt.trim() || undefined,
      width: preset.width,
      height: preset.height,
      steps,
      guidance,
      seed: seed >= 0 ? seed : undefined,
      loraIds: loraIdList,
      loraWeights,
    }
    autoCheckFiredRef.current = false
    lastGenParamsRef.current = { params: genParams, isAdult: genIsAdult }
    try {
      await generate(genParams, genIsAdult)
    } finally {
      setPending(false)
    }
  }, [prompt, negativePrompt, aspectPreset, steps, guidance, seed, selectedLoras, loras, autoMode, gen.status, generate, reset])

  const handleCancel = useCallback(() => {
    if (gen.imageId) cancel(gen.imageId)
    else reset()
  }, [gen.imageId, cancel, reset])

  const toggleLora = useCallback((id: string) => {
    setSelectedLoras(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const randomSeed = useCallback(() => {
    setSeed(Math.floor(Math.random() * 2_147_483_647))
  }, [])

  const handleDeleteImage = useCallback(async (imageId: string) => {
    await fetch(`/api/image/artifacts/${imageId}`, { method: 'DELETE' }).catch(() => {})
    setHistory(prev => prev.filter(item => item.id !== imageId))
    setEditHistory(prev => prev.filter(item => item.id !== imageId))
    if (selectedHistoryId === imageId) setSelectedHistoryId(null)
    if (selectedEditHistoryId === imageId) setSelectedEditHistoryId(null)
    if (gen.imageId === imageId) reset()
  }, [selectedHistoryId, selectedEditHistoryId, gen.imageId, reset])

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (editSourcePreview) URL.revokeObjectURL(editSourcePreview)
    const preview = URL.createObjectURL(file)
    setEditSourceFile(file)
    setEditSourcePreview(preview)
    setEditSourceId(null)
    resetEdit()
  }, [editSourcePreview, resetEdit])

  const acceptDrop = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    if (editSourcePreview) URL.revokeObjectURL(editSourcePreview)
    const preview = URL.createObjectURL(file)
    setEditSourceFile(file)
    setEditSourcePreview(preview)
    setEditSourceId(null)
    resetEdit()
    setActiveTab('edit')
  }, [editSourcePreview, resetEdit])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropOver(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDropOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) acceptDrop(file)
  }, [acceptDrop])

  const handlePickHistoryForEdit = useCallback((id: string) => {
    if (editSourcePreview) URL.revokeObjectURL(editSourcePreview)
    setEditSourcePreview(null)
    setEditSourceFile(null)
    setEditSourceId(id)
    resetEdit()
  }, [editSourcePreview, resetEdit])

  const handleRunEdit = useCallback(async () => {
    if (!editOp || (!editSourceId && !editSourceFile) || edit.status === 'running') return
    setSelectedEditHistoryId(null)
    resetEdit()
    const source = editSourceFile
      ? { file: editSourceFile }
      : { imageId: editSourceId! }
    const editOptions =
      editOp === 'enhance'       ? { strength: enhanceStrength } :
      editOp === 'face-restore'  ? { model: faceRestoreModel, fidelity: faceRestoreFidelity } :
      editOp === 'photo-restore' ? {
        model: faceRestoreModel,
        fidelity: faceRestoreFidelity,
        photoRestoreFaces:   photoRestoreFaces  && faceRestoreNodeAvailable && (codeformerAvailable || gfpganAvailable),
        photoRestoreUpscale: photoRestoreUpscale && upscaleAvailableState,
      } :
      editOp === 'bg-blur' ? { blurRadius: bgBlurRadius } :
      editOp === 'adjust' ? {
        brightness: adjBrightness,
        contrast:   adjContrast,
        saturation: adjSaturation,
        sharpness:  adjSharpness,
      } :
      undefined
    await runEdit(editOp, source, editOptions)
  }, [editOp, editSourceId, editSourceFile, edit.status, runEdit, resetEdit])

  // Clear prompt + selection if the selected gallery item becomes hidden by the privacy toggle
  useEffect(() => {
    if (!privacyEnabled || adultVisible || !selectedHistoryId) return
    const item = history.find(h => h.id === selectedHistoryId)
    if (!item?.isAdult) return
    setSelectedHistoryId(null)
    setPrompt('')
    setSelectedLoras(new Set())
  }, [privacyEnabled, adultVisible, selectedHistoryId, history])

  // Determine what to show in the generation result panel
  // Hide adult-flagged generation result when privacy is active
  const activeGenIsAdult = privacyEnabled && imaging.isAdult && !adultVisible
  const selectedHistoryIsAdult = privacyEnabled && !adultVisible &&
    !!(selectedHistoryId && history.find(h => h.id === selectedHistoryId)?.isAdult)
  const genDisplayImageId = activeGenIsAdult ? selectedHistoryId : (selectedHistoryId ?? (gen.status === 'done' ? gen.imageId : null))
  const genDisplaySrc = genDisplayImageId ? `/api/image/artifacts/${genDisplayImageId}` : null

  // Edit panel: result → gallery selection → history source → uploaded preview
  const editResultSrc = edit.imageId ? `/api/image/artifacts/${edit.imageId}` : null
  const editDisplaySrc = editResultSrc
    ?? (selectedEditHistoryId ? `/api/image/artifacts/${selectedEditHistoryId}` : null)
    ?? (editSourceId ? `/api/image/artifacts/${editSourceId}` : null)
    ?? editSourcePreview

  const editHasSource = !!(editSourceId || editSourceFile)
  const faceRestoreReady = faceRestoreModel === 'codeformer' ? codeformerAvailable : gfpganAvailable
  const canRunEdit = editHasSource && !!editOp && edit.status !== 'running'
    && (editOp !== 'face-restore'  || faceRestoreReady)
    && (editOp !== 'photo-restore' || photoRestoreAvailable)

  const editBeforeSrc = editSourceId
    ? `/api/image/artifacts/${editSourceId}`
    : editSourcePreview ?? null
  const showCompare = edit.status === 'done' && !!editResultSrc && !!editBeforeSrc

  // Prompt for the currently displayed image (history item or active generation)
  const displayedPrompt = activeTab === 'generate' && genDisplaySrc && !activeGenIsAdult
    ? (history.find(h => h.id === genDisplayImageId)?.prompt ?? (genDisplayImageId === gen.imageId ? imaging.activePrompt : null) ?? null)
    : null

  // Privacy-filtered history strips
  const visibleHistory = privacyEnabled && !adultVisible
    ? history.filter(h => !h.isAdult)
    : history
  const visibleEditHistory = privacyEnabled && !adultVisible
    ? editHistory.filter(h => !h.isAdult)
    : editHistory

  return (
    <>
    <PageShell>
      <div className="flex-1 flex min-h-0 overflow-hidden">

        {/* ── Icon sidebar ─────────────────────────────────────────────────── */}
        <nav className="w-16 flex flex-col items-center gap-0.5 pt-2 pb-3 border-r border-border shrink-0 bg-background">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  'flex flex-col items-center gap-1 w-full px-1 py-2.5 rounded-xl transition-colors',
                  activeTab === item.id
                    ? 'text-brand bg-brand/10'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                )}
              >
                <Icon className="size-5" />
                <span className="text-[10px] font-medium leading-none">{item.label}</span>
              </button>
            )
          })}
        </nav>

        {/* ── Secondary panel ──────────────────────────────────────────────── */}
        <div className="w-72 flex flex-col min-h-0 border-r border-border shrink-0 bg-background">
          <div className="relative px-4 py-3.5 border-b border-border/40 bg-background/70 backdrop-blur-md shrink-0">
            <ChromeWash />
            <h2 className="relative text-sm font-semibold">
              {activeTab === 'generate' ? 'Generate' : activeTab === 'edit' ? 'Edit' : activeTab === 'recognize' ? 'Recognize' : 'Logo'}
            </h2>
            <p className="relative mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {activeTab === 'generate'
                ? 'Create images from text prompts using local AI models.'
                : activeTab === 'edit'
                ? 'Enhance, transform, and retouch any photo — fully offline.'
                : activeTab === 'recognize'
                ? 'Analyze images — describe scenes, read text, detect objects.'
                : 'Generate logos and icons from a text description.'}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">

            {/* ── Generate panel ──────────────────────────────────────────── */}
            {activeTab === 'generate' && (
              <>
                {repairJob && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400 space-y-1.5">
                    <span className="flex items-center gap-2">
                      <Loader2 className="size-3 animate-spin shrink-0" />
                      <span>Re-downloading <span className="font-medium">{repairJob.label}</span> — a model file was corrupted and is being automatically repaired.</span>
                    </span>
                    {repairJob.pct !== null && (
                      <div className="w-full h-1.5 rounded-full bg-amber-500/20 overflow-hidden">
                        <div className="h-full rounded-full bg-amber-500 transition-all duration-500" style={{ width: `${repairJob.pct}%` }} />
                      </div>
                    )}
                    <span className="text-amber-500/70">{repairJob.pct !== null ? `${repairJob.pct}% complete` : 'Queued…'} — generation will resume automatically when done.</span>
                  </div>
                )}
                {imageGenAvailable === false && !repairJob && (
                  <div className={cn('rounded-xl border px-3 py-2.5 text-xs',
                    imageGenState === 'warming'
                      ? 'border-sky-500/30 bg-sky-500/10 text-sky-400'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
                  )}>
                    {imageGenState === 'not_installed'
                      ? 'Image generation isn\'t installed. Go to Admin → Features to set it up.'
                      : imageGenState === 'warming'
                      ? <span className="flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Starting up image generation…</span>
                      : 'Image generation ran into an issue. Try reloading, or visit Admin → Troubleshooting.'}
                  </div>
                )}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="prompt" className="text-xs font-semibold">Prompt</Label>
                    <span className="text-[10px] text-muted-foreground">{prompt.length}/600</span>
                  </div>
                  {(activeGenIsAdult && gen.status === 'generating') || selectedHistoryIsAdult ? (
                    <div className="min-h-[100px] flex items-center justify-center rounded-xl border border-border/60 bg-muted/30">
                      <span className="text-xs text-muted-foreground">Unlock to view prompt</span>
                    </div>
                  ) : (
                    <Textarea
                      id="prompt"
                      placeholder="Describe what you want to generate…"
                      value={prompt}
                      onChange={e => setPrompt(e.target.value)}
                      disabled={gen.status === 'generating'}
                      className="min-h-[100px] resize-none text-sm rounded-xl"
                      maxLength={600}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate() }}
                    />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setAutoMode(v => !v)}
                  disabled={gen.status === 'generating'}
                  className={cn(
                    'w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                    autoMode
                      ? 'border-brand/40 bg-brand/8 hover:bg-brand/12'
                      : 'border-border bg-muted/20 hover:bg-muted/40',
                  )}
                >
                  <div className={cn('relative shrink-0 h-5 w-9 rounded-full transition-colors', autoMode ? 'bg-brand' : 'bg-muted-foreground/30')}>
                    <div className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform', autoMode ? 'translate-x-4' : 'translate-x-0.5')} />
                  </div>
                  <div className="min-w-0">
                    <p className={cn('text-[11px] font-semibold leading-tight', autoMode ? 'text-brand' : 'text-muted-foreground')}>Auto</p>
                    <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">AI refines your prompt and balances style weights for best results</p>
                  </div>
                </button>
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Ratio</Label>
                  <div className="flex gap-1.5 flex-wrap">
                    {ASPECT_PRESETS.map((p, i) => {
                      const [rw, rh] = p.label.split(':').map(Number)
                      return (
                        <button key={p.label} onClick={() => setAspectPreset(i)} disabled={gen.status === 'generating'}
                          className={cn('flex flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-[10px] font-medium transition-colors border min-w-[44px]',
                            aspectPreset === i ? 'border-brand text-brand bg-brand/10' : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground')}>
                          <RatioIcon ratioW={rw} ratioH={rh} />
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <LoraPicker loras={privacyEnabled && !adultVisible ? loras.filter(l => !l.isAdult) : loras} selected={selectedLoras} onToggle={toggleLora} />
                {sentLoraInfo.length > 0 && gen.status !== 'idle' && (
                  <div className="rounded-xl border border-border/50 bg-muted/30 px-3 py-2.5 space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sent to model</p>
                    {sentLoraInfo.map(l => {
                      const weight = sentLoraWeights[l.id] ?? l.defaultWeight
                      return (
                        <div key={l.id} className="flex items-start gap-2">
                          {l.thumbnailUrl && <img src={l.thumbnailUrl} alt="" className="size-6 rounded object-cover shrink-0 mt-0.5" />}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[11px] font-medium text-foreground leading-tight truncate">{l.styleLabel ?? l.name}</p>
                              <span className="text-[10px] font-mono text-muted-foreground shrink-0">{weight.toFixed(2)}×</span>
                            </div>
                            {l.triggerTokens.length > 0 && <p className="text-[10px] text-sky-400/80 font-mono leading-tight mt-0.5">{l.triggerTokens.join(', ')}</p>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                <Collapsible open={paramsOpen} onOpenChange={setParamsOpen}>
                  <CollapsibleTrigger asChild>
                    <button className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors">
                      <span className="flex items-center gap-1.5"><Settings2 className="size-3.5" />Advanced</span>
                      {paramsOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-3 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Steps <span className="text-foreground">{steps}</span></Label>
                          <input type="range" min={1} max={40} step={1} value={steps} onChange={e => setSteps(parseInt(e.target.value, 10) || 20)} disabled={gen.status === 'generating'} className="w-full accent-primary" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Guidance <span className="text-foreground">{guidance.toFixed(1)}</span></Label>
                          <input type="range" min={0} max={10} step={0.5} value={guidance} onChange={e => { const v = parseFloat(e.target.value); setGuidance(Number.isNaN(v) ? 3.5 : v) }} disabled={gen.status === 'generating'} className="w-full accent-primary" />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Negative prompt</Label>
                        <Textarea placeholder="Things to avoid in the image…" value={negativePrompt} onChange={e => setNegativePrompt(e.target.value)} disabled={gen.status === 'generating'} className="min-h-[52px] resize-none text-xs rounded-xl" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Seed</Label>
                        <div className="flex gap-2">
                          <Input type="number" min={-1} value={seed} onChange={e => setSeed(parseInt(e.target.value, 10) || -1)} disabled={gen.status === 'generating'} className="text-xs h-8 rounded-xl" placeholder="-1 (random)" />
                          <Button variant="outline" size="sm" onClick={randomSeed} disabled={gen.status === 'generating'} className="shrink-0 px-2.5 h-8 rounded-xl"><RefreshCw className="size-3.5" /></Button>
                        </div>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
                {gen.status === 'error' && gen.error && (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{gen.error}</div>
                )}
              </>
            )}

            {/* ── Edit panel ──────────────────────────────────────────────── */}
            {activeTab === 'edit' && (
              <>
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Source image</Label>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    className={cn(
                      'w-full rounded-xl border-2 border-dashed px-4 py-5 text-xs text-center transition-colors',
                      dropOver ? 'border-brand bg-brand/10 text-brand'
                        : editSourceFile ? 'border-brand/40 bg-brand/5 text-brand hover:bg-brand/10'
                        : 'border-border text-muted-foreground hover:border-brand/40 hover:bg-muted',
                    )}
                  >
                    <Upload className="size-4 mx-auto mb-1.5 opacity-60" />
                    {dropOver ? 'Drop to use this image' : editSourceFile ? editSourceFile.name : 'Upload or drop an image'}
                  </button>
                  {([...visibleHistory, ...visibleEditHistory].filter(h => h.state === 'ready').length > 0) && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">or from gallery</p>
                      <div className="grid grid-cols-5 gap-1.5 max-h-36 overflow-y-auto">
                        {[...visibleHistory, ...visibleEditHistory].filter(h => h.state === 'ready').map(item => (
                          <HistoryTile key={item.id} item={item} selected={editSourceId === item.id}
                            onClick={() => { if (editSourceId === item.id) { setEditSourceId(null); resetEdit() } else { handlePickHistoryForEdit(item.id) } }} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {(['Enhance', 'Transform', 'Restore'] as const).map(group => {
                  const ops = EDIT_OPERATIONS.filter(op => op.group === group)
                  return (
                    <div key={group} className="space-y-2">
                      <Label className="text-xs font-semibold">{group}</Label>
                      <div className="grid grid-cols-2 gap-2">
                        {ops.map(op => {
                          const Icon = op.icon
                          return (
                            <button key={op.id}
                              onClick={() => {
                                setEditOp(editOp === op.id ? null : op.id)
                                if (op.id === 'face-restore' && editOp !== op.id) {
                                  if (!codeformerAvailable && gfpganAvailable) setFaceRestoreModel('gfpgan')
                                  else setFaceRestoreModel('codeformer')
                                }
                              }}
                              className={cn('flex flex-col rounded-xl overflow-hidden border-2 transition-all',
                                editOp === op.id ? 'border-brand' : 'border-transparent hover:border-border')}
                            >
                              <div className="w-full aspect-video flex items-center justify-center" style={{ background: op.cardGrad }}>
                                <Icon className="size-6 text-white drop-shadow-sm" />
                              </div>
                              <div className="px-2 py-1.5 bg-muted/40">
                                <p className="text-[11px] font-medium text-center leading-tight">{op.label}</p>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                {editOp === 'enhance' && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <Label>Strength</Label>
                      <span className="text-foreground">{Math.round(enhanceStrength * 100)}%</span>
                    </div>
                    <input type="range" min={0.05} max={0.75} step={0.05} value={enhanceStrength} onChange={e => setEnhanceStrength(parseFloat(e.target.value))} className="w-full accent-primary" />
                    <div className="flex justify-between text-[10px] text-muted-foreground"><span>Subtle polish</span><span>Deblur / reconstruct</span></div>
                  </div>
                )}
                {editOp === 'bg-blur' && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <Label>Blur strength</Label>
                      <span className="text-foreground">{bgBlurRadius}</span>
                    </div>
                    <input type="range" min={1} max={31} step={1} value={bgBlurRadius} onChange={e => setBgBlurRadius(parseInt(e.target.value))} className="w-full accent-primary" />
                    <div className="flex justify-between text-[10px] text-muted-foreground"><span>Subtle</span><span>Strong</span></div>
                  </div>
                )}
                {editOp === 'face-restore' && (
                  <div className="space-y-3">
                    {!codeformerAvailable && !gfpganAvailable && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                        No face restore model installed. Go to <strong>Admin → Install</strong> to download CodeFormer or GFPGAN.
                      </div>
                    )}
                    {(codeformerAvailable || gfpganAvailable) && !faceRestoreNodeAvailable && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                        Face models installed but ComfyUI node is missing. Go to <strong>Admin → Install</strong>.
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Model</Label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {([
                          { id: 'codeformer', label: 'CodeFormer', sub: 'Fidelity control', available: codeformerAvailable },
                          { id: 'gfpgan',     label: 'GFPGAN',     sub: 'Faster',           available: gfpganAvailable     },
                        ] as const).map(m => (
                          <button key={m.id} onClick={() => m.available && setFaceRestoreModel(m.id)} disabled={!m.available}
                            className={cn('rounded-xl border px-3 py-2 text-left transition-colors',
                              !m.available ? 'border-border bg-muted text-muted-foreground opacity-50 cursor-not-allowed'
                                : faceRestoreModel === m.id ? 'border-brand bg-brand/5 text-foreground'
                                : 'border-border bg-background text-muted-foreground hover:bg-muted')}>
                            <p className="text-xs font-medium">{m.label}</p>
                            <p className="text-[10px] mt-0.5 opacity-70">{m.available ? m.sub : 'Not installed'}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                    {faceRestoreModel === 'codeformer' && (
                      <div className="space-y-1.5">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <Label>Fidelity</Label>
                          <span className="text-foreground">{Math.round(faceRestoreFidelity * 100)}%</span>
                        </div>
                        <input type="range" min={0} max={1} step={0.05} value={faceRestoreFidelity} onChange={e => setFaceRestoreFidelity(parseFloat(e.target.value))} className="w-full accent-primary" />
                        <div className="flex justify-between text-[10px] text-muted-foreground"><span>Max restoration</span><span>Preserve likeness</span></div>
                      </div>
                    )}
                  </div>
                )}
                {editOp === 'photo-restore' && (
                  <div className="space-y-3">
                    {!photoRestoreAvailable && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                        Requires CodeFormer, GFPGAN, or ESRGAN. Go to <strong>Admin → Install</strong>.
                      </div>
                    )}
                    {(codeformerAvailable || gfpganAvailable) && !faceRestoreNodeAvailable && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                        Face models installed but ComfyUI node is missing. Go to <strong>Admin → Install</strong>.
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Steps</Label>
                      {[
                        { key: 'faces',   label: 'Enhance faces', desc: 'Run CodeFormer / GFPGAN on detected faces', value: photoRestoreFaces,   set: setPhotoRestoreFaces,   enabled: faceRestoreNodeAvailable && (codeformerAvailable || gfpganAvailable) },
                        { key: 'upscale', label: 'Upscale 4×',   desc: 'Increase resolution with ESRGAN',           value: photoRestoreUpscale, set: setPhotoRestoreUpscale, enabled: upscaleAvailableState },
                      ].map(({ key, label, desc, value, set, enabled }) => (
                        <button key={key} onClick={() => enabled && set(!value)} disabled={!enabled}
                          className={cn('w-full flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors',
                            !enabled ? 'border-border bg-muted opacity-50 cursor-not-allowed'
                              : value ? 'border-brand bg-brand/5 text-foreground'
                              : 'border-border bg-background text-foreground hover:bg-muted')}>
                          <div>
                            <p className="text-xs font-medium">{label}</p>
                            <p className="text-[10px] text-muted-foreground mt-0.5">{enabled ? desc : 'Not installed'}</p>
                          </div>
                          <div className={cn('size-4 rounded border flex items-center justify-center shrink-0', value && enabled ? 'bg-brand border-brand' : 'border-border')}>
                            {value && enabled && <div className="size-2 rounded-sm bg-brand-foreground" />}
                          </div>
                        </button>
                      ))}
                    </div>
                    {photoRestoreFaces && faceRestoreNodeAvailable && codeformerAvailable && (
                      <div className="space-y-1.5">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <Label>Face fidelity</Label>
                          <span className="text-foreground">{Math.round(faceRestoreFidelity * 100)}%</span>
                        </div>
                        <input type="range" min={0} max={1} step={0.05} value={faceRestoreFidelity} onChange={e => setFaceRestoreFidelity(parseFloat(e.target.value))} className="w-full accent-primary" />
                        <div className="flex justify-between text-[10px] text-muted-foreground"><span>Max restoration</span><span>Preserve likeness</span></div>
                      </div>
                    )}
                  </div>
                )}
                {editOp === 'adjust' && (
                  <div className="space-y-3">
                    {([
                      { label: 'Brightness', value: adjBrightness, set: setAdjBrightness },
                      { label: 'Contrast',   value: adjContrast,   set: setAdjContrast   },
                      { label: 'Saturation', value: adjSaturation, set: setAdjSaturation },
                      { label: 'Sharpness',  value: adjSharpness,  set: setAdjSharpness  },
                    ] as const).map(({ label, value, set }) => (
                      <div key={label} className="space-y-1">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <Label>{label}</Label>
                          <span className={value !== 0 ? 'text-foreground font-medium' : ''}>{value > 0 ? `+${value}` : value}</span>
                        </div>
                        <input type="range" min={-100} max={100} step={5} value={value} onChange={e => set(parseInt(e.target.value))} className="w-full accent-primary" />
                      </div>
                    ))}
                    <button onClick={() => { setAdjBrightness(0); setAdjContrast(0); setAdjSaturation(0); setAdjSharpness(0) }} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Reset all</button>
                  </div>
                )}
                {edit.status === 'error' && edit.error && (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{edit.error}</div>
                )}
              </>
            )}

            {/* ── Recognize panel ─────────────────────────────────────────── */}
            {activeTab === 'recognize' && (
              <>
                {visionAvailable === false && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400">
                    No vision model installed. Go to <strong>Admin → Models</strong> and install a vision-capable model (e.g. Gemma 3 4B).
                  </div>
                )}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Image to analyze</Label>
                  <input ref={recognizeFileInputRef} type="file" accept="image/*" className="hidden" onChange={handleRecognizeFileUpload} />
                  <button
                    onClick={() => recognizeFileInputRef.current?.click()}
                    onDragOver={onRecognizeDragOver}
                    onDragLeave={onRecognizeDragLeave}
                    onDrop={onRecognizeDrop}
                    className={cn(
                      'w-full rounded-xl border-2 border-dashed px-4 py-5 text-xs text-center transition-colors',
                      recognizeDropOver ? 'border-brand bg-brand/10 text-brand'
                        : recognizeFile ? 'border-brand/40 bg-brand/5 text-brand hover:bg-brand/10'
                        : 'border-border text-muted-foreground hover:border-brand/40 hover:bg-muted',
                    )}
                  >
                    <Upload className="size-4 mx-auto mb-1.5 opacity-60" />
                    {recognizeDropOver ? 'Drop to analyze' : recognizeFile ? recognizeFile.name : 'Upload or drop an image'}
                  </button>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold">What to look for</Label>
                    <button
                      onClick={() => setSelectedTasks(prev => prev.size === ANALYSIS_TASKS.length ? new Set() : new Set(ANALYSIS_TASKS.map(t => t.id)))}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {selectedTasks.size === ANALYSIS_TASKS.length ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {ANALYSIS_TASKS.map(task => {
                      const Icon = task.icon
                      const active = selectedTasks.has(task.id)
                      return (
                        <button key={task.id} onClick={() => toggleTask(task.id)}
                          className={cn('flex flex-col rounded-xl overflow-hidden border-2 transition-all text-left',
                            active ? 'border-brand' : 'border-transparent hover:border-border')}>
                          <div className="w-full aspect-video flex items-center justify-center" style={{ background: task.cardGrad }}>
                            <Icon className="size-6 text-white drop-shadow-sm" />
                          </div>
                          <div className="px-2 py-1.5 bg-muted/40">
                            <p className="text-[11px] font-medium text-center leading-tight">{task.label}</p>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground">Leave all unselected to run everything</p>
                </div>
                {analyzeStatus === 'error' && analyzeError && (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{analyzeError}</div>
                )}
                {analyzeStatus === 'done' && analyzeResult && (
                  <div className="space-y-3 pt-1 border-t border-border">
                    {analyzeResult.inference && (
                      <div className="space-y-2 pt-2">
                        {analyzeResult.inference.summary && (
                          <p className="text-xs leading-relaxed text-foreground/90 font-medium">{analyzeResult.inference.summary}</p>
                        )}
                        <div className="flex flex-wrap gap-1.5">
                          {analyzeResult.inference.timeOfDay && <span className="rounded-full bg-sky-900/40 border border-sky-700/30 px-2 py-0.5 text-[10px] text-sky-300">{analyzeResult.inference.timeOfDay}</span>}
                          {analyzeResult.inference.weather && <span className="rounded-full bg-blue-900/40 border border-blue-700/30 px-2 py-0.5 text-[10px] text-blue-300">{analyzeResult.inference.weather}</span>}
                          {analyzeResult.inference.country && <span className="rounded-full bg-zinc-800/60 border border-zinc-600/30 px-2 py-0.5 text-[10px] text-zinc-300">{analyzeResult.inference.country}</span>}
                          {(analyzeResult.inference.sourceBrand || analyzeResult.inference.sourceType) && (
                            <span className="rounded-full bg-emerald-900/40 border border-emerald-700/30 px-2 py-0.5 text-[10px] text-emerald-300">
                              {[analyzeResult.inference.sourceBrand, analyzeResult.inference.sourceType].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    {analyzeResult.safety?.some(s => s.assessment !== 'normal') && (
                      <div className="space-y-1.5">
                        {analyzeResult.safety.filter(s => s.assessment !== 'normal').map((s: SafetyFlag, i: number) => (
                          <div key={i} className={cn('rounded-xl border px-3 py-2 space-y-0.5',
                            s.assessment === 'critical' ? 'border-red-500/40 bg-red-950/40' : 'border-orange-500/30 bg-orange-950/30')}>
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs">{s.assessment === 'critical' ? '🔴' : '🟠'}</span>
                              <span className="text-xs font-semibold capitalize text-foreground">{s.hazard}</span>
                              <span className="text-[10px] text-muted-foreground">· {s.context}</span>
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug">{s.reason}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {analyzeResult.description && (
                      <div className="space-y-1 pt-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Description</p>
                        <p className="text-xs leading-relaxed">{analyzeResult.description}</p>
                      </div>
                    )}
                    {analyzeResult.scene && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Scene</p>
                        <p className="text-xs">{analyzeResult.scene}</p>
                      </div>
                    )}
                    {analyzeResult.objects.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Objects</p>
                        <div className="space-y-1.5">
                          {analyzeResult.objects.map((obj, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <span className="flex-1 text-xs capitalize">{obj.label}</span>
                              <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                                <div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(obj.confidence * 100)}%` }} />
                              </div>
                              <span className="text-[10px] text-muted-foreground w-8 text-right">{Math.round(obj.confidence * 100)}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {analyzeResult.vehicles.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Vehicles</p>
                        {analyzeResult.vehicles.map((v, i) => (
                          <div key={i} className="rounded-xl border border-border bg-muted/40 px-3 py-2 space-y-1 text-xs">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Car className="size-3 text-muted-foreground shrink-0" />
                              <span className="font-medium">{[v.brand, v.model].filter(Boolean).join(' ') || v.type}</span>
                              {(v.brand || v.model) && <span className="text-muted-foreground capitalize">· {v.type}</span>}
                              {v.color && <span className="text-muted-foreground">· {v.color}</span>}
                            </div>
                            {(v.plate || v.plateState) && (
                              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <span className="font-mono font-semibold text-foreground">{v.plate ?? '???'}</span>
                                {v.plateState && <span>({v.plateState})</span>}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {analyzeResult.text.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Text found</p>
                        {analyzeResult.text.map((t, i) => (
                          <div key={i} className="rounded-xl border border-border bg-muted/40 px-3 py-2">
                            <p className="text-xs font-mono font-medium break-all">{t.value}</p>
                            <p className="text-[10px] text-muted-foreground mt-0.5 capitalize">{t.type.replace('_', ' ')} · {t.language.toUpperCase()}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* ── Logo panel ──────────────────────────────────────────────── */}
            {activeTab === 'logo' && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Name</Label>
                  <input
                    value={logoName} onChange={e => setLogoName(e.target.value)}
                    placeholder="Brand or show name…"
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-muted-foreground">Tagline (optional)</Label>
                  <input
                    value={logoTagline} onChange={e => setLogoTagline(e.target.value)}
                    placeholder="A short tagline…"
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Style</Label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {LOGO_STYLES.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setLogoStyle(s.id)}
                        className={cn(
                          'rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors',
                          logoStyle === s.id ? 'border-brand bg-brand/10 text-brand' : 'border-border hover:bg-muted',
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground">Primary</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color" value={logoPrimaryColor}
                        onChange={e => setLogoPrimaryColor(e.target.value)}
                        className="size-8 rounded cursor-pointer border border-border"
                      />
                      <span className="text-xs text-muted-foreground font-mono">{logoPrimaryColor}</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground">Accent</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color" value={logoAccentColor}
                        onChange={e => setLogoAccentColor(e.target.value)}
                        className="size-8 rounded cursor-pointer border border-border"
                      />
                      <span className="text-xs text-muted-foreground font-mono">{logoAccentColor}</span>
                    </div>
                  </div>
                </div>
                {logoError && (
                  <p className="text-xs text-destructive rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">{logoError}</p>
                )}
                {logoSvg && (
                  <div className="flex gap-1.5 flex-wrap">
                    <button onClick={downloadLogoSvg} className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted">
                      <Download className="size-3" /> SVG
                    </button>
                    <button onClick={downloadLogoPng} className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted">
                      <Download className="size-3" /> PNG
                    </button>
                    <button onClick={copyLogoSvg} className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted">
                      <Copy className="size-3" /> Copy SVG
                    </button>
                  </div>
                )}
              </>
            )}

          </div>

          {/* ── Action button ────────────────────────────────────────────────── */}
          <div className="shrink-0 p-4 border-t border-border">
            {activeTab === 'generate' && (
              gen.status === 'generating' ? (
                <Button onClick={handleCancel} variant="outline" className="w-full gap-2 h-12 rounded-2xl">
                  <X className="size-4" /> Cancel
                </Button>
              ) : (
                <Button onClick={handleGenerate} disabled={!prompt.trim() || imageGenAvailable === false || !!repairJob || pending}
                  className="w-full gap-2 h-12 rounded-2xl font-semibold text-base"
                  style={{ background: 'linear-gradient(135deg,#6366f1,#ec4899)', border: 'none' }}>
                  {pending ? <Loader2 className="size-5 animate-spin" /> : <Wand2 className="size-5" />} Generate
                </Button>
              )
            )}
            {activeTab === 'edit' && (
              edit.status === 'running' ? (
                <Button onClick={() => edit.imageId ? cancelEdit(edit.imageId) : resetEdit()} variant="outline" className="w-full gap-2 h-12 rounded-2xl">
                  <X className="size-4" /> Cancel
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Button onClick={handleRunEdit} disabled={!canRunEdit} className="flex-1 gap-2 h-12 rounded-2xl font-semibold"
                    style={canRunEdit ? { background: 'linear-gradient(135deg,#6366f1,#ec4899)', border: 'none' } : {}}>
                    <Wand2 className="size-5" /> Run
                  </Button>
                  {edit.status === 'done' && edit.imageId && (
                    <Button variant="outline" size="sm" onClick={resetEdit} className="px-3 h-12 rounded-2xl"><RefreshCw className="size-4" /></Button>
                  )}
                </div>
              )
            )}
            {activeTab === 'recognize' && (
              <div className="flex gap-2">
                <Button onClick={handleAnalyze} disabled={!recognizeFile || analyzeStatus === 'running' || visionAvailable === false}
                  className="flex-1 gap-2 h-12 rounded-2xl font-semibold"
                  style={recognizeFile && visionAvailable !== false ? { background: 'linear-gradient(135deg,#6366f1,#ec4899)', border: 'none' } : {}}>
                  {analyzeStatus === 'running' ? (
                    <><div className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin shrink-0" />Analyzing…</>
                  ) : (
                    <><ScanLine className="size-5" />Analyze</>
                  )}
                </Button>
                {(analyzeStatus === 'done' || analyzeStatus === 'error') && (
                  <Button variant="outline" size="sm" onClick={analyzeReset} className="px-3 h-12 rounded-2xl"><RefreshCw className="size-4" /></Button>
                )}
              </div>
            )}
            {activeTab === 'logo' && (
              <div className="space-y-2">
                <Button
                  onClick={handleLogoGenerate}
                  disabled={!logoName.trim() || logoLoading}
                  className="w-full gap-2 h-12 rounded-2xl font-semibold"
                  style={logoName.trim() ? { background: 'linear-gradient(135deg,#6d28d9,#a855f7)', border: 'none' } : {}}
                >
                  {logoLoading ? <Loader2 className="size-4 animate-spin" /> : <Sparkle className="size-4" />}
                  Instant SVG
                </Button>
                <Button
                  variant="outline"
                  onClick={handleLogoQuality}
                  disabled={!logoName.trim() || logoQualityLoading || imageGenAvailable === false}
                  className="w-full gap-2 h-10 rounded-2xl text-sm"
                >
                  {logoQualityLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                  HD Quality (Image Gen)
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* ── Canvas ───────────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0">

          <div className="flex-1 relative p-4 min-h-0">
            <div
              className={cn(
                'relative w-full h-full rounded-2xl overflow-hidden bg-muted border transition-colors',
                activeTab === 'edit' && dropOver
                  ? 'border-brand border-2 bg-brand/5'
                  : 'border-border',
              )}
              onDragOver={activeTab === 'edit' ? onDragOver : undefined}
              onDragLeave={activeTab === 'edit' ? onDragLeave : undefined}
              onDrop={activeTab === 'edit' ? onDrop : undefined}
            >
              {/* Drop overlay */}
              {activeTab === 'edit' && dropOver && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 pointer-events-none">
                  <Upload className="size-10 text-brand opacity-80" />
                  <p className="text-sm text-brand font-medium">Drop to edit</p>
                </div>
              )}

              {/* ── Generation result ──────────────────────────────────────── */}
              {activeTab === 'generate' && (
                <>
                  {/* Safety veto — generation stopped by content policy */}
                  {autoPhase === 'blocked' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 text-center">
                      <ImageOff className="size-9 text-red-400" />
                      <p className="text-sm text-white font-medium">Generation stopped</p>
                      <p className="text-xs text-white/60 max-w-xs">This image was stopped by a content-safety policy and cannot be produced.</p>
                      <Button size="sm" variant="secondary" onClick={() => setAutoPhase('idle')}>Dismiss</Button>
                    </div>
                  )}

                  {/* Auto correcting — between cancel and re-generate */}
                  {autoPhase === 'correcting' && gen.status !== 'generating' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
                      <div className="size-8 rounded-full border-2 border-brand/40 border-t-brand animate-spin" />
                      <p className="text-sm text-white/80 font-medium">Auto correcting…</p>
                      <p className="text-xs text-white/50">Adjusting weights and retrying</p>
                    </div>
                  )}

                  {gen.status === 'generating' && !activeGenIsAdult && (
                    <>
                      {gen.previewUrl ? (
                        <img
                          src={gen.previewUrl}
                          alt="Preview"
                          className="absolute inset-0 w-full h-full object-contain"
                          style={{ filter: 'blur(2px)', transform: 'scale(1.02)' }}
                        />
                      ) : (
                        <div
                          className="absolute inset-0 animate-pulse"
                          style={{ background: 'linear-gradient(135deg, hsl(var(--muted)) 0%, hsl(var(--muted-foreground)/0.1) 50%, hsl(var(--muted)) 100%)' }}
                        />
                      )}
                      <div className="absolute inset-0 bg-black/30" />
                      <GenProgress step={gen.step} total={gen.totalSteps} elapsedMs={gen.elapsedMs} />
                      {/* Auto check indicator */}
                      {autoMode && autoPhase !== 'idle' && (
                        <div className="absolute bottom-12 inset-x-0 flex justify-center pointer-events-none">
                          <div className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 backdrop-blur-sm">
                            <div className="size-2 rounded-full bg-brand animate-pulse" />
                            <span className="text-[11px] text-white/80 font-medium">
                              {autoPhase === 'checking' ? 'Auto checking preview…' : 'Correcting…'}
                            </span>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {gen.status === 'generating' && activeGenIsAdult && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                      <div className="size-8 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
                      <p className="text-sm opacity-60">Generating…</p>
                    </div>
                  )}

                  {gen.status !== 'generating' && genDisplaySrc && (
                    <ResultImage
                      src={genDisplaySrc}
                      prompt={prompt}
                      onDelete={genDisplayImageId ? () => setConfirmDeleteImageId(genDisplayImageId) : undefined}
                      onFullscreen={() => setFullscreenSrc({ src: genDisplaySrc, prompt })}
                    />
                  )}

                  {gen.status === 'idle' && !genDisplaySrc && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                      <Sparkles className="size-12 opacity-20" />
                      <p className="text-sm opacity-50">Enter a prompt to generate</p>
                    </div>
                  )}

                  {gen.status === 'cancelled' && !genDisplaySrc && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                      <X className="size-8 opacity-40" />
                      <p className="text-sm opacity-60">Generation cancelled</p>
                    </div>
                  )}
                </>
              )}

              {/* ── Editing result ─────────────────────────────────────────── */}
              {activeTab === 'edit' && (
                <>
                  {edit.status === 'running' && (
                    <>
                      {edit.previewUrl ? (
                        <img
                          src={edit.previewUrl}
                          alt="Preview"
                          className="absolute inset-0 w-full h-full object-contain"
                          style={{ filter: 'blur(2px)', transform: 'scale(1.02)' }}
                        />
                      ) : editDisplaySrc ? (
                        <img
                          src={editDisplaySrc}
                          alt="source"
                          className="absolute inset-0 w-full h-full object-contain opacity-30"
                          style={{ filter: 'blur(2px)' }}
                        />
                      ) : (
                        <div
                          className="absolute inset-0 animate-pulse"
                          style={{ background: 'linear-gradient(135deg, hsl(var(--muted)) 0%, hsl(var(--muted-foreground)/0.1) 50%, hsl(var(--muted)) 100%)' }}
                        />
                      )}
                      <div className="absolute inset-0 bg-black/30" />
                      {edit.totalSteps > 1 ? (
                        <GenProgress step={edit.step} total={edit.totalSteps} elapsedMs={edit.elapsedMs} />
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                          <div className="size-8 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                          <p className="text-sm text-white/60 animate-pulse">Processing…</p>
                        </div>
                      )}
                    </>
                  )}

                  {edit.status !== 'running' && edit.status !== 'error' && editDisplaySrc && (
                    showCompare
                      ? (
                        <div className="relative w-full h-full group">
                          <CompareSlider beforeSrc={editBeforeSrc!} afterSrc={editResultSrc!} />
                          <div className="absolute bottom-3 right-3 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => setFullscreenSrc({ src: editResultSrc!, prompt: '' })}
                              className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white transition-colors"
                            ><Maximize2 className="size-4" /></button>
                            <button
                              onClick={() => { const a = document.createElement('a'); a.href = editResultSrc!; a.download = `image-${edit.imageId?.slice(0, 8) ?? 'edit'}.png`; a.click() }}
                              className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white transition-colors"
                            ><Download className="size-4" /></button>
                          </div>
                        </div>
                      )
                      : <ResultImage src={editDisplaySrc} prompt="edited image" onFullscreen={() => setFullscreenSrc({ src: editDisplaySrc, prompt: '' })} />
                  )}

                  {edit.status === 'idle' && !editDisplaySrc && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                      <Pencil className="size-8 opacity-40" />
                      <p className="text-sm opacity-60">Choose an image and operation to get started</p>
                    </div>
                  )}

                  {edit.status === 'error' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground px-6">
                      <X className="size-8 opacity-40" />
                      <p className="text-sm opacity-60">Edit failed</p>
                      {edit.error && <p className="text-xs opacity-50 text-center">{edit.error}</p>}
                    </div>
                  )}
                </>
              )}

              {/* ── Recognition source image ───────────────────────────────── */}
              {activeTab === 'recognize' && (
                <>
                  {analyzeStatus === 'running' && (
                    <>
                      {recognizePreview && (
                        <img
                          src={recognizePreview}
                          alt="Analyzing"
                          className="absolute inset-0 w-full h-full object-contain opacity-40"
                          style={{ filter: 'blur(1px)' }}
                        />
                      )}
                      <div className="absolute inset-0 bg-black/20" />
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                        <div className="size-8 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                        <p className="text-sm text-white/60 animate-pulse">Analyzing image…</p>
                      </div>
                    </>
                  )}
                  {analyzeStatus !== 'running' && recognizePreview && (
                    <img
                      src={recognizePreview}
                      alt="Source"
                      className="absolute inset-0 w-full h-full object-contain"
                    />
                  )}
                  {analyzeStatus === 'idle' && !recognizePreview && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                      <ScanLine className="size-8 opacity-40" />
                      <p className="text-sm opacity-60">Upload an image to analyze</p>
                    </div>
                  )}
                </>
              )}

              {/* ── Logo canvas ───────────────────────────────────────────────── */}
              {activeTab === 'logo' && (
                <>
                  {logoLoading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                      <div className="size-10 rounded-full border-2 border-purple-500/30 border-t-purple-500 animate-spin" />
                      <p className="text-sm text-muted-foreground">Generating logo…</p>
                    </div>
                  )}
                  {!logoLoading && logoSvg && (
                    <div className="absolute inset-0 flex items-center justify-center p-8">
                      {/* Render the LLM-generated SVG as an image, not via innerHTML — an
                          <img> won't execute <script>/onload inside the SVG (XSS guard). */}
                      <img
                        src={`data:image/svg+xml;utf8,${encodeURIComponent(logoSvg)}`}
                        alt="Generated logo"
                        className="mx-auto h-full w-full object-contain"
                      />
                    </div>
                  )}
                  {!logoLoading && !logoSvg && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                      <Layers className="size-12 opacity-20" />
                      <p className="text-sm opacity-60">Enter a name and click Instant SVG</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Prompt used for the currently displayed image */}
          {displayedPrompt && (
            <div className="shrink-0 px-4 py-1.5 border-t border-border/40 bg-muted/20">
              <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                <span className="font-medium text-foreground/50">Prompt: </span>{displayedPrompt}
              </p>
            </div>
          )}

          {/* Thumbnail strip — generate only */}
          {activeTab === 'generate' && visibleHistory.length > 0 && (
            <div className="flex gap-2 px-4 pb-3 pt-2 overflow-x-auto shrink-0 border-t border-border">
              {visibleHistory.map(item => (
                <div key={item.id} className="size-16 shrink-0">
                  <HistoryTile
                    item={item}
                    selected={item.id === selectedHistoryId}
                    onClick={() => {
                      setSelectedHistoryId(item.id)
                      if (item.prompt) setPrompt(item.prompt)
                      try {
                        const ids: string[] = item.loraIds ? JSON.parse(item.loraIds) : []
                        setSelectedLoras(new Set(ids))
                      } catch { setSelectedLoras(new Set()) }
                    }}
                    onDelete={() => setConfirmDeleteImageId(item.id)}
                    onEdit={() => { handlePickHistoryForEdit(item.id); setActiveTab('edit') }}
                    onFullscreen={() => setFullscreenSrc({ src: `/api/image/artifacts/${item.id}`, prompt: item.prompt })}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </PageShell>

    {fullscreenSrc && <Lightbox src={fullscreenSrc.src} prompt={fullscreenSrc.prompt} onClose={() => setFullscreenSrc(null)} />}

    <ConfirmDialog
      open={confirmDeleteImageId !== null}
      onOpenChange={open => !open && setConfirmDeleteImageId(null)}
      title="Delete this image?"
      description="This will permanently remove the image. This action cannot be undone."
      confirmLabel="Delete"
      destructive
      onConfirm={() => { if (confirmDeleteImageId) { void handleDeleteImage(confirmDeleteImageId); setConfirmDeleteImageId(null) } }}
    />

    <ConfirmDialog
      open={confirmDeleteAnalysisId !== null}
      onOpenChange={open => !open && setConfirmDeleteAnalysisId(null)}
      title="Delete this analysis?"
      description="This will permanently remove the analysis result. This action cannot be undone."
      confirmLabel="Delete"
      destructive
      onConfirm={() => { if (confirmDeleteAnalysisId) { void handleDeleteAnalysis(confirmDeleteAnalysisId); setConfirmDeleteAnalysisId(null) } }}
    />
    </>
  )
}
