import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Clapperboard, Film, ImagePlus, Loader2, Palette, Sparkles, Wand2, X, Download, Trash2, Search, ArrowRight } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useGenerationContext } from '@/context/GenerationContext'
import { usePrivacy } from '@/context/PrivacyContext'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'

type Mode = 't2v' | 'i2v'

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

function appendTriggerTokens(prompt: string, tokens: string[]): string {
  const missing = tokens.filter(t => !prompt.toLowerCase().includes(t.toLowerCase()))
  if (missing.length === 0) return prompt
  return prompt.trim() ? `${prompt.trimEnd()}, ${missing.join(', ')}` : missing.join(', ')
}

function removeTriggerTokens(prompt: string, tokens: string[]): string {
  let p = prompt
  for (const t of tokens) {
    p = p.replace(new RegExp(`(,\\s*)?\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(\\s*,)?`, 'gi'), (_, pre, post) => (pre && post ? ',' : '')).trim()
  }
  return p.replace(/^,\s*|,\s*$/g, '').replace(/,\s*,+/g, ',').trim()
}

function LoraPicker({ loras, selected, onToggle, disabled }: {
  loras: LoraOption[]
  selected: Set<string>
  onToggle: (id: string) => void
  disabled?: boolean
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
      <p className="text-xs font-semibold">Styles</p>
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="Search styles…"
            disabled={disabled}
            className="w-full h-7 pl-7 pr-6 text-xs rounded-lg border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          {searchInput && (
            <button onClick={clear} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </button>
          )}
        </div>
        <button
          onClick={submit}
          disabled={disabled}
          className="flex items-center justify-center size-7 rounded-lg bg-muted hover:bg-muted/80 active:scale-95 text-muted-foreground hover:text-foreground transition-all shrink-0 disabled:opacity-50"
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
            <div key={l.id} className="relative"
              onMouseEnter={() => setHoveredId(l.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <button
                onClick={() => onToggle(l.id)}
                disabled={disabled}
                className={cn(
                  'flex flex-col items-center gap-1 w-full rounded-xl border-2 p-1 transition-colors',
                  selected.has(l.id) ? 'border-brand' : 'border-transparent hover:border-border',
                  disabled && 'opacity-50 cursor-not-allowed',
                )}
              >
                {l.thumbnailUrl ? (
                  <img src={proxyImg(l.thumbnailUrl)} alt="" className="w-full aspect-square rounded-lg object-cover" />
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
                  {l.thumbnailUrl && <img src={proxyImg(l.thumbnailUrl)} alt="" className="w-full aspect-[3/4] object-cover" />}
                  <div className="p-2.5 space-y-1">
                    <p className="text-[11px] font-semibold text-white leading-tight">{l.name}</p>
                    {l.description && <p className="text-[10px] text-white/50 leading-snug line-clamp-4">{l.description}</p>}
                    {l.triggerTokens.length > 0 && <p className="text-[10px] text-sky-400/70 font-mono leading-tight">{l.triggerTokens.join(', ')}</p>}
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

interface ImageStatus {
  videoAvailable?: boolean
  i2vAvailable?: boolean
  ok?: boolean
}

const GRADIENT = 'linear-gradient(135deg,#6d28d9,#db2777)'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function NumberStepper({ label, value, min, max, step = 1, onChange, disabled }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; disabled?: boolean
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-card px-3 py-2', disabled && 'opacity-50')}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <button onClick={() => onChange(Math.max(min, value - step))} disabled={disabled}
          className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-sm hover:bg-muted disabled:cursor-not-allowed">−</button>
        <span className="w-12 text-center text-sm font-semibold tabular-nums">{value}</span>
        <button onClick={() => onChange(Math.min(max, value + step))} disabled={disabled}
          className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-sm hover:bg-muted disabled:cursor-not-allowed">+</button>
      </div>
    </div>
  )
}

export function VideoPage() {
  const [mode, setMode] = useState<Mode>('t2v')
  const [status, setStatus] = useState<ImageStatus | null>(null)

  const [frames, setFrames] = useState(14)
  const [fps, setFps] = useState(8)

  const [imageBase64, setImageBase64] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [motion, setMotion] = useState(127)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { video } = useGenerationContext()
  const { state, generate, cancel, reset } = video
  const { enabled: privacyEnabled, adultVisible } = usePrivacy()

  const [loras, setLoras] = useState<LoraOption[]>([])
  const [selectedLoras, setSelectedLoras] = useState<Set<string>>(() =>
    state.status === 'generating' && video.activeLoraIds ? new Set(video.activeLoraIds) : new Set()
  )
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  interface VideoHistoryItem { id: string; prompt: string; state: string; pipeline: string; isAdult: boolean }
  const [history, setHistory] = useState<VideoHistoryItem[]>([])

  // Restore prompt when returning to page mid-generation
  const [prompt, setPrompt] = useState(() => state.status === 'generating' ? (video.activePrompt ?? '') : '')

  // On mount: detect any orphaned or mis-flagged building job and reconnect/correct it.
  // Handles two cases:
  //   1. Context still alive (generating) → correct isAdult if the frontend got it wrong
  //   2. Context reset (idle, e.g. after page refresh) → reconnect to the running SSE stream
  useEffect(() => {
    interface BuildingJob { id: string; pipeline: string; isAdult: boolean; prompt: string | null; steps: number }
    const currentStatus = state.status
    const currentImageId = state.imageId
    fetch('/api/image/building', { credentials: 'include' })
      .then(r => r.ok ? (r.json() as Promise<BuildingJob | null>) : null)
      .then(d => {
        if (!d || (d.pipeline !== 'video' && d.pipeline !== 'i2v')) return
        if (currentStatus === 'idle') {
          // Reconnect to an orphaned job (full SSE re-attach)
          video.reconnect(d.id, d.steps, d.isAdult, d.prompt)
        } else if (currentStatus === 'generating' && currentImageId === d.id) {
          // Already tracking it — just make sure isAdult is correct
          video.setIsAdult(d.isAdult)
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  usePublishUIContext({
    label: 'Video',
    description: 'Generating video on the Video page (text-to-video and image-to-video).',
  })

  const loadStatus = useCallback(() => {
    fetch('/api/image/status', { credentials: 'include' })
      .then(r => r.json())
      .then((d: ImageStatus) => setStatus(d))
      .catch(() => setStatus(null))
  }, [])
  useEffect(() => { loadStatus() }, [loadStatus])

  const loadHistory = useCallback(() => {
    fetch('/api/image/history?limit=24&kind=generated', { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((data: VideoHistoryItem[]) =>
        setHistory(data.filter(h => h.pipeline === 'video' || h.pipeline === 'i2v'))
      )
      .catch(() => {})
  }, [])
  useEffect(() => { loadHistory() }, [loadHistory])

  useEffect(() => {
    if (state.status === 'done') loadHistory()
  }, [state.status, loadHistory])

  useEffect(() => {
    fetch('/api/image/loras', { credentials: 'include' })
      .then(r => r.json())
      .then((data: LoraOption[]) => setLoras(data))
      .catch(() => {})
  }, [])

  const toggleLora = useCallback((id: string) => {
    const lora = loras.find(l => l.id === id)
    setSelectedLoras(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        if (lora?.triggerTokens.length) setPrompt(p => removeTriggerTokens(p, lora.triggerTokens))
      } else {
        next.add(id)
        if (lora?.triggerTokens.length) setPrompt(p => appendTriggerTokens(p, lora.triggerTokens))
      }
      return next
    })
  }, [loras])

  const available = mode === 't2v' ? status?.videoAvailable : status?.i2vAvailable
  const generating = state.status === 'generating'
  const [pending, setPending] = useState(false)

  const onPickFile = async (file: File | undefined) => {
    if (!file) return
    const b64 = await fileToBase64(file)
    setImageBase64(b64)
    setImagePreview(URL.createObjectURL(file))
  }

  const handleDelete = useCallback(async (id: string) => {
    await fetch(`/api/image/artifacts/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
    setHistory(prev => prev.filter(h => h.id !== id))
    if (state.imageId === id) reset()
  }, [state.imageId, reset])

  const handleGenerate = async () => {
    if (generating) return
    setPending(true)
    reset()
    try {
      if (mode === 't2v') {
        if (!prompt.trim()) return
        const loraIdList = Array.from(selectedLoras)
        const genIsAdult = loras.filter(l => loraIdList.includes(l.id)).some(l => l.isAdult)
        await generate({ prompt: prompt.trim(), videoMode: true, frames, fps, loraIds: loraIdList }, genIsAdult)
      } else {
        if (!imageBase64) return
        await generate({ prompt: '', i2vMode: true, imageBase64, frames, fps, motionBucketId: motion })
      }
    } finally {
      setPending(false)
    }
  }

  const activeIsAdult = privacyEnabled && video.isAdult && !adultVisible
  const resultSrc = state.status === 'done' && state.imageId && !activeIsAdult
    ? `/api/image/artifacts/${state.imageId}`
    : null
  const lastHistoryItem = state.status === 'idle'
    ? history.find(h => !privacyEnabled || adultVisible || !h.isAdult) ?? null
    : null
  const lastResultSrc = lastHistoryItem ? `/api/image/artifacts/${lastHistoryItem.id}` : null
  const pct = state.totalSteps > 0 ? Math.min(100, Math.round((state.step / state.totalSteps) * 100)) : 0
  const visibleHistory = privacyEnabled && !adultVisible
    ? history.filter(h => !h.isAdult)
    : history

  return (
    <PageShell>
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">

        {/* ── Left: Canvas + thumbnail strip ──────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0">

          {/* Canvas */}
          <div className="flex-1 relative p-4 min-h-[280px] lg:min-h-0 lg:max-h-[480px]">
            <div className="relative w-full h-full rounded-2xl overflow-hidden bg-muted border border-border flex items-center justify-center">

              {/* Generating — visible */}
              {generating && !activeIsAdult && (
                <>
                  {state.previewUrl ? (
                    <img src={state.previewUrl} alt="preview"
                      className="absolute inset-0 w-full h-full object-contain" />
                  ) : (
                    <div className="absolute inset-0 animate-pulse"
                      style={{ background: 'linear-gradient(135deg, hsl(var(--muted)) 0%, hsl(var(--muted-foreground)/0.1) 50%, hsl(var(--muted)) 100%)' }} />
                  )}
                  <div className="absolute inset-0 bg-black/30" />
                  <div className="absolute inset-x-0 bottom-0 p-6">
                    <div className="h-1.5 w-full rounded-full bg-black/40 overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${Math.max(4, pct)}%`, background: GRADIENT }} />
                    </div>
                    <p className="text-xs text-white/60 mt-2 text-center">
                      Generating… {pct}% · {(state.elapsedMs / 1000).toFixed(0)}s
                    </p>
                  </div>
                </>
              )}

              {/* Generating — adult hidden */}
              {generating && activeIsAdult && (
                <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground">
                  <div className="size-8 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
                  <p className="text-sm opacity-60">Generating…</p>
                </div>
              )}

              {/* Result or last history */}
              {!generating && (resultSrc || lastResultSrc) && (
                <div className="relative w-full h-full group">
                  <img src={resultSrc ?? lastResultSrc!} alt="result"
                    className="absolute inset-0 w-full h-full object-contain" />
                  <div className="absolute bottom-3 left-3 rounded-lg px-2 py-1 bg-black/50 text-xs text-white/70 pointer-events-none">
                    {frames} frames @ {fps} fps
                  </div>
                  <div className="absolute bottom-3 right-3 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <a href={resultSrc ?? lastResultSrc!} download
                      className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white transition-colors">
                      <Download className="size-4" />
                    </a>
                  </div>
                </div>
              )}

              {/* Error */}
              {state.status === 'error' && (
                <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground px-6 text-center">
                  <X className="size-8 opacity-40" />
                  <p className="text-sm opacity-60">{state.error ?? 'Generation failed'}</p>
                </div>
              )}

              {/* Empty */}
              {!generating && !resultSrc && !lastResultSrc && state.status !== 'error' && (
                <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground">
                  <Clapperboard className="size-12 opacity-20" />
                  <p className="text-sm opacity-50">Your video will appear here</p>
                </div>
              )}
            </div>
          </div>

          {/* Thumbnail strip — privacy-filtered */}
          {visibleHistory.length > 0 && (
            <div className="flex gap-2 px-4 pb-4 overflow-x-auto shrink-0">
              {visibleHistory.map(item => (
                <div key={item.id} className="group relative shrink-0 w-24 aspect-video rounded-xl overflow-hidden bg-muted border border-border/50">
                  <img
                    src={`/api/image/artifacts/${item.id}`}
                    alt={item.prompt}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                  {item.prompt && (
                    <div className="absolute bottom-0 inset-x-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                      <div className="bg-gradient-to-t from-black/80 to-transparent px-1.5 pt-4 pb-5">
                        <p className="text-[9px] text-white/85 line-clamp-2 leading-tight">{item.prompt}</p>
                      </div>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 opacity-0 group-hover:opacity-100 transition-all flex items-end justify-end gap-1 p-1">
                    <a href={`/api/image/artifacts/${item.id}`} download onClick={e => e.stopPropagation()}
                      className="p-1 rounded bg-black/60 hover:bg-black/80 text-white">
                      <Download className="size-3" />
                    </a>
                    <button onClick={() => setConfirmDeleteId(item.id)}
                      className="p-1 rounded bg-black/60 hover:bg-red-600/80 text-white">
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Right: Controls panel ────────────────────────────────────────── */}
        <div className="lg:w-[380px] lg:min-w-[340px] flex flex-col lg:border-l border-border min-h-0 border-t lg:border-t-0">

          {/* Scrollable controls */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5">

            {/* Mode switch */}
            <div className="grid grid-cols-2 gap-2 rounded-2xl bg-muted/50 p-1">
              {([['t2v', 'Text to Video', Wand2], ['i2v', 'Image to Video', Film]] as const).map(([m, label, Icon]) => (
                <button key={m} onClick={() => setMode(m)} disabled={generating}
                  className={cn(
                    'flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors',
                    mode === m ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
                    generating && 'opacity-50 cursor-not-allowed',
                  )}>
                  <Icon className="size-4" /> {label}
                </button>
              ))}
            </div>

            {/* Not installed banner */}
            {status && available === false && (
              <div className="flex items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-4 py-4">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                  <Sparkles className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">
                    {mode === 't2v' ? 'Text-to-Video' : 'Image-to-Video'} isn't installed yet
                  </p>
                  <p className="text-xs text-muted-foreground">Install from Admin → Features</p>
                </div>
                <Link to="/admin/features"
                  className="shrink-0 rounded-lg bg-foreground/10 px-3 py-1.5 text-xs font-semibold hover:bg-foreground/15">
                  Install
                </Link>
              </div>
            )}

            {/* T2V: Prompt */}
            {mode === 't2v' && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold">Prompt</label>
                  {!activeIsAdult && <span className="text-[10px] text-muted-foreground">{prompt.length}/500</span>}
                </div>
                {activeIsAdult ? (
                  <div className="h-[104px] flex items-center justify-center rounded-xl border border-border/60 bg-muted/30">
                    <span className="text-xs text-muted-foreground">Unlock to view prompt</span>
                  </div>
                ) : (
                  <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    readOnly={generating}
                    placeholder='Describe the clip — e.g. "a paper boat sailing down a rainy street, cinematic"'
                    rows={4}
                    maxLength={500}
                    className={cn('w-full resize-none rounded-xl border border-border/60 bg-card px-4 py-3 text-sm outline-none focus:border-brand/60', generating && 'opacity-60 cursor-not-allowed')}
                  />
                )}
              </div>
            )}

            {/* I2V: Image upload */}
            {mode === 'i2v' && (
              <div className="space-y-2">
                <label className="text-xs font-semibold">Source image</label>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                  onChange={e => void onPickFile(e.target.files?.[0])} />
                {imagePreview ? (
                  <div className="relative overflow-hidden rounded-xl border border-border/60">
                    <img src={imagePreview} alt="source" className="max-h-48 w-full object-contain bg-black/20" />
                    <button onClick={() => { setImageBase64(null); setImagePreview(null) }}
                      className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : (
                  <button onClick={() => fileInputRef.current?.click()}
                    className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/60 bg-card/40 py-10 text-muted-foreground hover:border-brand/40 hover:text-foreground">
                    <ImagePlus className="size-7" />
                    <span className="text-sm font-medium">Upload a photo to animate</span>
                  </button>
                )}
              </div>
            )}

            {/* LoRA picker — t2v only; filter adult styles when privacy locked */}
            {mode === 't2v' && (
              <LoraPicker
                loras={privacyEnabled && !adultVisible ? loras.filter(l => !l.isAdult) : loras}
                selected={selectedLoras}
                onToggle={generating ? () => {} : toggleLora}
                disabled={generating}
              />
            )}

            {/* Output settings */}
            <div className="space-y-2">
              <label className="text-xs font-semibold">Output settings</label>
              <NumberStepper label="Frames" value={frames} min={8} max={mode === 'i2v' ? 25 : 24} onChange={setFrames} disabled={generating} />
              <NumberStepper label="FPS" value={fps} min={4} max={24} onChange={setFps} disabled={generating} />
              {mode === 'i2v' && (
                <NumberStepper label="Motion" value={motion} min={1} max={255} step={16} onChange={setMotion} disabled={generating} />
              )}
            </div>

            {state.status === 'error' && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {state.error ?? 'Generation failed'}
              </div>
            )}
          </div>

          {/* ── Pinned generate button ─────────────────────────────────────── */}
          <div className="shrink-0 p-4 border-t border-border">
            {generating ? (
              <button onClick={() => state.imageId && cancel(state.imageId)}
                className="w-full h-12 flex items-center justify-center gap-2 rounded-2xl bg-destructive/15 text-sm font-semibold text-destructive hover:bg-destructive/25 transition-colors">
                <X className="size-4" /> Cancel
              </button>
            ) : (
              <button
                onClick={() => void handleGenerate()}
                disabled={available === false || (mode === 't2v' ? !prompt.trim() : !imageBase64) || pending}
                className="w-full h-12 flex items-center justify-center gap-2 rounded-2xl text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                style={{ background: GRADIENT }}
              >
                {pending ? <Loader2 className="size-5 animate-spin" /> : <Clapperboard className="size-5" />} Generate video
              </button>
            )}
          </div>
        </div>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={open => !open && setConfirmDeleteId(null)}
        title="Delete this video?"
        description="This will permanently remove the video file."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (confirmDeleteId) { void handleDelete(confirmDeleteId); setConfirmDeleteId(null) } }}
      />
      </div>
    </PageShell>
  )
}
