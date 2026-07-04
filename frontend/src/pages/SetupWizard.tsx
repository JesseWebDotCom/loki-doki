import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Sparkles, Lock, Package, Download, CheckCircle2, ChevronRight, ChevronLeft, ChevronDown, Settings2,
  Bot, Eye, Database, Wand2, Mic, Server, Route, ScanFace, Film, Eraser, Library, Code2,
  Map as MapIcon, Ear, MessageSquare, Image as ImageIcon, Users, Home, Lightbulb, Cpu,
  MapPin, Navigation, ShieldCheck, WifiOff, Lock as LockIcon, AlertTriangle, Globe,
  ShieldQuestion,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { useServerHealth } from '@/context/ServerHealthContext'
import { BrandMark } from '@/components/shared/BrandMark'
import { PinPad } from '@/components/shared/PinPad'
import { DownloadProgress } from '@/components/shared/DownloadProgress'
import type { DownloadStatus } from '@/components/shared/DownloadProgress'
import { ResourceBars } from '@/components/shared/ResourceBars'
import { InstallPromo } from '@/components/setup/InstallPromo'
import { CompanionOrb } from '@/components/companion/CompanionOrb'
import { useUserLocation } from '@/hooks/useUserLocation'
import { DicebearAvatarPicker } from '@/components/shared/DicebearAvatarPicker'
import { randomSeed } from '@/components/companion/styleSchemas'
import { MIN_DIALS, MAX_DIALS } from '@/components/shared/contentDials'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

// ── Types (mirroring backend catalog) ────────────────────────────────────────

type ModelRole =
  | 'llm' | 'uncensored_llm' | 'vision' | 'embeddings' | 'router' | 'router_llm'
  | 'image_gen' | 'face_id' | 'face_embed' | 'video_motion' | 'video_gen' | 'bg_remove'
  | 'voice' | 'coding' | 'runtime' | 'component'

interface CatalogEntry {
  id: string
  role: ModelRole
  label: string
  description: string
  backend: 'ollama' | 'huggingface' | 'url'
  approxBytes: number
  tags: string[]
  format?: string
  backendLabel?: string
  required?: boolean
  installed: boolean
  recommended: boolean
  tiers: string[]
  builtinVision?: boolean
  linkedWith?: string[]
  requires?: string[]
}

interface CatalogTier { id: string; label: string; detail: string }

interface CatalogResponse {
  hardware: { totalRamGb: number; isAppleSilicon: boolean; platform: string }
  recommendedTier: string
  tiers: CatalogTier[]
  models: CatalogEntry[]
  disk: { freeBytes: number; totalBytes: number }
  ollamaRunning: boolean
  ollamaInstalled: boolean
  ollamaInstallBytes: number
  activeModelIds: Record<string, string | null>
}

interface ModelDownload {
  id: string
  role: ModelRole
  label: string
  status: DownloadStatus
  completed: number
  total: number
  speedBps: number
  etaSeconds: number
  error?: string
  note?: string  // backend sub-status while no bytes have flowed yet (resolving / connecting)
}

// ── Wizard steps ──────────────────────────────────────────────────────────────

type Step = 'welcome' | 'profile' | 'pin' | 'consent' | 'area' | 'components' | 'download'

const STEP_ORDER: Step[] = ['welcome', 'profile', 'pin', 'consent', 'area', 'components', 'download']

const STEP_META: Record<Step, { icon: React.ComponentType<{ className?: string }>; label: string; sub: string }> = {
  welcome:    { icon: Sparkles,        label: 'Welcome',      sub: 'What you get' },
  profile:    { icon: Users,           label: 'Your profile', sub: 'Admin account' },
  pin:        { icon: Lock,            label: 'Secure it',    sub: 'Optional PIN' },
  consent:    { icon: ShieldQuestion,  label: 'Permissions',  sub: 'What you allow' },
  area:       { icon: MapPin,          label: 'Your area',    sub: 'Location & units' },
  components: { icon: Package,         label: 'Your AI',      sub: 'Models & features' },
  download:   { icon: Download,        label: 'Install',      sub: 'Download & finish' },
}

// ── Input style ───────────────────────────────────────────────────────────────

const inputCls = [
  'w-full rounded-control border border-border bg-card px-4 py-3 text-sm',
  'placeholder:text-muted-foreground/50',
  'focus:outline-none focus:ring-2 focus:ring-brand/40',
  'transition-all',
].join(' ')

// ── Role labels ───────────────────────────────────────────────────────────────

const ROLE_ICONS: Record<ModelRole, React.ComponentType<{ className?: string }>> = {
  runtime: Server, llm: Bot, uncensored_llm: Bot, vision: Eye, embeddings: Database,
  router: Route, router_llm: Route, image_gen: Wand2, face_id: ScanFace, face_embed: Database,
  video_motion: Film, bg_remove: Eraser, voice: Mic, coding: Code2,
}

const ROLE_LABELS: Record<ModelRole, string> = {
  llm: 'Language Model', uncensored_llm: 'Uncensored Model', vision: 'Vision Model',
  embeddings: 'Embedding Model', router: 'Tool Router', router_llm: 'Router LLM',
  image_gen: 'Image Base', face_id: 'Face Identity', face_embed: 'Face Embedder',
  video_motion: 'Video Generation', bg_remove: 'Background Removal', voice: 'Voice Model', coding: 'Coding Model', runtime: 'Runtime',
}

const ROLE_ORDER: ModelRole[] = [
  'llm', 'uncensored_llm', 'vision', 'embeddings', 'router', 'router_llm',
  'image_gen', 'face_id', 'video_motion', 'bg_remove', 'voice', 'coding',
]

const IMAGE_GEN_ROLES = new Set<ModelRole>(['image_gen', 'face_id', 'video_motion', 'bg_remove'])
const CHAT_ROLES      = new Set<ModelRole>(['vision', 'embeddings', 'router', 'router_llm', 'coding'])

function formatBytes(b: number): string {
  if (b <= 0) return '-'
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${(b / 1_073_741_824).toFixed(1)} GB`
}

// ── Optional capabilities ──────────────────────────────────────────────────────

interface Capability {
  id: string; label: string; description: string; bytes: number
  defaultOn: boolean; requires: string[]; icon: React.ComponentType<{ className?: string }>
  // base: true → installs inline with the models (not deferred to background queue)
  base?: boolean
}

// Base applications install inline alongside the models. Shown under their own
// “Base Applications” heading so it's clear they're part of the core install.
// Non-base capabilities are enqueued to the background job manager after boot.
const CAPABILITIES: Capability[] = [
  { id: 'tesseract',     label: 'Home Inventory',     description: 'Snap a photo - AI identifies your devices and tracks warranties (Tesseract OCR)', bytes: 30_000_000,  defaultOn: true,  requires: [],             base: true, icon: Home },
  { id: 'searxng',       label: 'Web Search',          description: 'High-quality web search via a local SearXNG metasearch engine - aggregates Google, Brave & Startpage so search works where direct scraping is blocked', bytes: 300_000_000, defaultOn: true,  requires: [],             icon: Globe },
  { id: 'voice-core',   label: 'Voice',               description: 'Read replies aloud and speak to your AI (Kokoro + Whisper)',                        bytes: 320_000_000, defaultOn: false, requires: [],             icon: Mic },
  { id: 'wakeword-core', label: 'Wake Word',          description: 'Hands-free “Hey Jarvis” activation',                                                bytes: 6_000_000,   defaultOn: false, requires: ['voice-core'], icon: Ear },
  { id: 'esphome',       label: 'Devices',             description: 'Build & flash firmware for ESP32 voice satellites (Atom Echo, etc.). Adds the ESP32 toolchain (~1 GB) - install later if you have devices.', bytes: 1_000_000_000, defaultOn: false, requires: [],             icon: Cpu },
]

// ── Feature showcase (welcome step + left panel) ────────────────────────────────

const FEATURES: { icon: React.ComponentType<{ className?: string }>; name: string; blurb: string; chip: string }[] = [
  { icon: MessageSquare, name: 'Chat',          blurb: 'An AI that remembers you and looks things up - privately', chip: 'bg-info/15 text-info' },
  { icon: ImageIcon,     name: 'Images & Video', blurb: 'Generate anything. No filters, no refusals for adults',    chip: 'bg-brand/15 text-brand' },
  { icon: Users,         name: 'Companions',     blurb: 'An animated buddy with its own voice and personality',     chip: 'bg-brand/15 text-brand' },
  { icon: Mic,           name: 'Voice',          blurb: 'Say a wakeword and just talk - it listens and speaks back', chip: 'bg-info/15 text-info' },
  { icon: Library,       name: 'Books & References', blurb: 'Whole book collections & Wikipedia with no internet',   chip: 'bg-warning/15 text-warning' },
  { icon: MapIcon,       name: 'Offline Maps',   blurb: 'Maps and turn-by-turn directions, no data plan',           chip: 'bg-success/15 text-success' },
  { icon: Home,          name: 'Home Inventory', blurb: 'Snap a photo - the AI tracks your devices & warranties',   chip: 'bg-success/15 text-success' },
  { icon: Lightbulb,     name: 'Home Control',   blurb: '“Turn off the office lights” - controls your smart home',  chip: 'bg-warning/15 text-warning' },
]

const VALUE_PROPS: { icon: React.ComponentType<{ className?: string }>; text: string }[] = [
  { icon: ShieldCheck, text: 'Private - your data never leaves home' },
  { icon: WifiOff,     text: 'Works offline, no subscriptions' },
  { icon: LockIcon,    text: 'Family-safe by default, optionally uncensored for adults' },
]

// ── Two-pane shell ──────────────────────────────────────────────────────────────

function WizardShell({ step, children, onNavigate, maxIdx }: { step: Step; children: React.ReactNode; onNavigate?: (s: Step) => void; maxIdx: number }) {
  const idx = STEP_ORDER.indexOf(step)
  const canBack = !!onNavigate && idx > 0 && step !== 'download'
  // Welcome lives in the right pane; the left rail tracks the remaining setup steps.
  const railSteps = STEP_ORDER.filter(s => s !== 'welcome')

  return (
    <div className="relative flex h-screen overflow-hidden bg-background">
      {/* Ambient glow: absolute (not fixed) so it stays contained to this full-screen shell,
          same decorative treatment as BootScreen. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-20 top-1/4 size-[600px] rounded-full bg-brand/10 blur-[150px]" />
        <div className="absolute right-0 bottom-0 size-[500px] rounded-full bg-brand/6 blur-[140px]" />
      </div>

      {/* Left brand / showcase panel */}
      <aside className="relative z-10 hidden w-[42%] max-w-md shrink-0 flex-col justify-between overflow-hidden border-r border-border/50 bg-gradient-to-b from-brand/[0.08] via-background to-background px-10 py-10 lg:flex">
        <div>
          <div className="flex items-center gap-3">
            <BrandMark glow className="size-10" />
            <div>
              {/* design-ok(raw-h1-in-pages): compact brand wordmark next to the logo mark, mirrors BootScreen */}
              <h1 className="text-xl font-bold tracking-tight leading-none">LokiDoki</h1>
              <p className="text-xs text-muted-foreground mt-0.5">Your private AI home hub</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center gap-6 py-6">
          <CompanionOrb size={150} active seed="loki-doki-setup" />
          <div className="space-y-2.5">
            {VALUE_PROPS.map(vp => (
              <div key={vp.text} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <vp.icon className="size-4 shrink-0 text-brand" />
                <span>{vp.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Vertical step rail */}
        <div className="space-y-1">
          {railSteps.map((s) => {
            const sIdx = STEP_ORDER.indexOf(s)
            const done = sIdx < idx
            const active = sIdx === idx
            const Icon = STEP_META[s].icon
            // Reachable: any step already visited, except the install step (it auto-runs).
            const clickable = !!onNavigate && step !== 'download' && s !== 'download' && sIdx <= maxIdx && !active
            return (
              <button key={s} type="button" disabled={!clickable} onClick={() => clickable && onNavigate!(s)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-control px-3 py-2 text-left transition-colors',
                  active && 'bg-brand/10',
                  clickable ? 'cursor-pointer hover:bg-accent/40' : 'cursor-default',
                )}>
                <div className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full transition-all',
                  done && 'bg-success text-success-foreground',
                  active && 'bg-brand text-brand-foreground shadow-lg shadow-brand/30',
                  !done && !active && 'bg-muted text-muted-foreground',
                )}>
                  {done ? <CheckCircle2 className="size-4" /> : <Icon className="size-3.5" />}
                </div>
                <div className="min-w-0">
                  <p className={cn('text-sm font-semibold leading-tight', !active && !done && 'text-muted-foreground')}>{STEP_META[s].label}</p>
                  <p className="text-[11px] text-muted-foreground/60 leading-tight">{STEP_META[s].sub}</p>
                </div>
              </button>
            )
          })}
        </div>
      </aside>

      {/* Right content pane */}
      <main className="relative z-10 flex h-screen flex-1 flex-col overflow-y-auto">
        {/* Mobile header */}
        <div className="flex items-center gap-2 border-b border-border/50 px-6 py-4 lg:hidden">
          <BrandMark className="size-8" />
          <span className="font-bold tracking-tight">LokiDoki</span>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{Math.max(1, idx)} / {railSteps.length}</span>
        </div>

        <div className="flex flex-1 items-start justify-center px-6 py-10 sm:px-10">
          <div className="w-full max-w-4xl">
            {canBack && (
              <button type="button" onClick={() => onNavigate!(STEP_ORDER[idx - 1]!)}
                className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
                <ChevronLeft className="size-4" /> Back
              </button>
            )}
            {children}
          </div>
        </div>
      </main>
    </div>
  )
}

// ── Welcome step ────────────────────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="w-full space-y-7 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="space-y-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-xs font-semibold text-brand">
          <Sparkles className="size-3.5" /> Welcome to your home AI
        </span>
        <h2 className="text-display sm:text-display-lg">
          A full AI stack that runs{' '}
          {/* The wizard's one sanctioned brand-gradient moment (hero text accent). */}
          <span className="bg-clip-text text-transparent" style={{ backgroundImage: 'var(--brand-gradient)' }}>in your home</span> and stays there.
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Private, uncensored, and free. Everything below runs on your own hardware - your conversations, images, and your family's data belong to no one but you. Let's set it up.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {FEATURES.map(f => (
          <div key={f.name} className="flex items-start gap-3 rounded-card border border-border bg-card/60 px-4 py-3">
            <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-control', f.chip)}>
              <f.icon className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight">{f.name}</p>
              <p className="text-xs text-muted-foreground leading-snug mt-0.5">{f.blurb}</p>
            </div>
          </div>
        ))}
      </div>

      <Button type="button" onClick={onNext} size="xl" className="w-full">
        Let's get started <ChevronRight className="size-4" />
      </Button>
      <p className="text-center text-xs text-muted-foreground/60">You choose what to install</p>
    </div>
  )
}

// ── Profile step ──────────────────────────────────────────────────────────────

type AvatarMode = 'avatar' | 'photo'

interface ProfileInitial {
  id: string; firstName: string; lastName: string; nickname: string
  avatarUrl: string | null; dicebearStyle: string | null; dicebearSeed: string | null; dicebearConfig: Record<string, unknown> | null
}

function ProfileStep({ onNext, editMode, initial }: { onNext: (id: string) => void; editMode?: boolean; initial?: ProfileInitial }) {
  const [firstName, setFirstName] = useState(initial?.firstName ?? '')
  const [lastName, setLastName]   = useState(initial?.lastName ?? '')
  const [nickname, setNickname]   = useState(initial?.nickname ?? '')
  const [nicknameTouched, setNicknameTouched] = useState(!!(initial?.nickname))
  const [birthdate, setBirthdate] = useState('')
  const [safeMode, setSafeMode] = useState(false)
  const [avatarMode, setAvatarMode] = useState<AvatarMode>(initial?.avatarUrl ? 'photo' : 'avatar')
  const [dbStyle, setDbStyle]   = useState(initial?.dicebearStyle ?? 'avataaars')
  const [dbSeed, setDbSeed]     = useState(() => initial?.dicebearSeed ?? randomSeed())
  const [dbConfig, setDbConfig] = useState<Record<string, unknown>>(initial?.dicebearConfig ?? {})
  const [photoFile, setPhotoFile]       = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(initial?.avatarUrl ?? null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => { if (!nicknameTouched) setNickname(firstName) }, [firstName])

  function pickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setPhotoFile(f)
    setPhotoPreview(URL.createObjectURL(f))
  }

  async function saveAvatar(id: string, hadPhoto: boolean) {
    const patch: Record<string, unknown> = { nickname: nickname.trim() || firstName.trim() }
    if (avatarMode === 'avatar') {
      if (hadPhoto) await fetch(`/api/users/${id}/avatar`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
      patch['dicebearStyle'] = dbStyle; patch['dicebearSeed'] = dbSeed; patch['dicebearConfig'] = JSON.stringify(dbConfig)
    }
    await fetch(`/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(patch) }).catch(() => {})
    if (avatarMode === 'photo' && photoFile) {
      const form = new FormData(); form.append('file', photoFile)
      await fetch(`/api/users/${id}/avatar`, { method: 'PUT', credentials: 'include', body: form }).catch(() => {})
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!firstName.trim() || !lastName.trim()) { setError('First and last name are required.'); return }
    if (!editMode && !birthdate) { setError('Date of birth is required.'); return }
    setLoading(true); setError('')
    try {
      // Editing an existing account (navigated back) - update in place, don't re-create.
      if (editMode && initial) {
        const patch: Record<string, unknown> = { firstName: firstName.trim(), lastName: lastName.trim() }
        if (birthdate) patch['birthdate'] = birthdate
        await fetch(`/api/users/${initial.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(patch) }).catch(() => {})
        await saveAvatar(initial.id, !!initial.avatarUrl)
        onNext(initial.id)
        return
      }

      const res = await fetch('/api/setup/admin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim(), birthdate }),
      })
      if (!res.ok) {
        const body = await res.json() as { error?: string }
        setError(body.error ?? 'Setup failed. Please try again.')
        setLoading(false)
        return
      }
      const { id } = await res.json() as { id: string }
      await saveAvatar(id, false)
      await fetch(`/api/users/${id}/preferences`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        // Write content dials directly (authoritative). Safe = all off; Uncensored = all max + blunt.
        body: JSON.stringify({
          content_dials: safeMode ? MIN_DIALS : MAX_DIALS,
          interaction_style: { candor: safeMode ? 'balanced' : 'blunt' },
        }),
      }).catch(() => {})
      onNext(id)
    } catch {
      setError('Could not reach the server. Make sure the backend is running.')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} className="w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_270px] md:items-start">

        {/* ── Left: form fields ── */}
        <div className="space-y-4">
          <div>
            <h2 className="text-title">{editMode ? 'Edit your profile' : 'Create your profile'}</h2>
            <p className="mt-1 text-sm text-muted-foreground">You're the admin, this account controls the whole household.</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input className={inputCls} placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
            <input className={inputCls} placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Nickname <span className="font-normal text-muted-foreground/50">(what your companion calls you)</span>
            </label>
            <input className={inputCls} placeholder={firstName.trim() || 'e.g. Jess'} value={nickname} onChange={(e) => { setNicknameTouched(true); setNickname(e.target.value) }} />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Date of birth {editMode && <span className="font-normal text-muted-foreground/50">(leave blank to keep current)</span>}
            </label>
            <input type="date" className={inputCls} value={birthdate} onChange={(e) => setBirthdate(e.target.value)} />
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <ShieldCheck className="size-3 shrink-0 text-brand" />
              Stays on your server - used only for age-appropriate content.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">AI content mode</label>
            <div className="flex gap-2">
              {([false, true] as const).map(val => (
                <button key={String(val)} type="button" onClick={() => setSafeMode(val)}
                  className={cn(
                    'flex flex-1 items-center gap-2 rounded-control border px-3 py-2 text-left text-sm transition-colors',
                    safeMode === val
                      ? 'border-brand/60 bg-brand/10 font-semibold text-foreground'
                      : 'border-border text-muted-foreground hover:border-border/80',
                  )}>
                  <span className={cn('size-2 shrink-0 rounded-full', safeMode === val ? 'bg-brand' : 'bg-muted-foreground/30')} />
                  {val ? 'Safe' : 'Uncensored'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: avatar ── */}
        <div className="min-w-0 overflow-hidden rounded-card border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Your avatar</span>
            <ToggleGroup
              value={avatarMode}
              onChange={setAvatarMode}
              options={[{ value: 'avatar', label: 'Create' }, { value: 'photo', label: 'Photo' }]}
            />
          </div>
          {avatarMode === 'avatar' ? (
            <DicebearAvatarPicker
              style={dbStyle}
              seed={dbSeed}
              config={dbConfig}
              onChange={(s, se, c) => { setDbStyle(s); setDbSeed(se); setDbConfig(c) }}
              vertical
            />
          ) : (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                {photoPreview ? <img src={photoPreview} alt="" className="size-full object-cover" /> : <ImageIcon className="size-7 text-muted-foreground/50" />}
              </div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickPhoto} />
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                {photoFile ? 'Change photo' : 'Choose photo'}
              </Button>
              <p className="text-xs text-muted-foreground">Stored on your server only.</p>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={loading} size="xl" className="w-full">
            {loading ? <Spinner className="text-current" /> : <>Continue <ChevronRight className="size-4" /></>}
          </Button>
        </div>

      </div>
    </form>
  )
}

// ── PIN step ──────────────────────────────────────────────────────────────────

function PinStep({ userId, onNext, onSkip, canSkip = true }: { userId: string; onNext: () => void; onSkip: () => void; canSkip?: boolean }) {
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone]       = useState(false)

  async function handleComplete(pin: string) {
    setLoading(true); setError('')
    try {
      const res = await fetch(`/api/users/${userId}/pin`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
      })
      if (res.ok) { setDone(true); setTimeout(onNext, 600); return }
      const body = await res.json() as { error?: string }
      setError(body.error ?? 'Could not save PIN.')
    } catch { setError('Could not reach the server.') } finally { setLoading(false) }
  }

  return (
    <div className="flex w-full flex-col items-center animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="mb-6 text-center">
        <h2 className="text-title">Secure your profile</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {canSkip
            ? 'Add a PIN to protect your profile. You can skip and add one later.'
            : 'Set a PIN for the administrator account. This is required to keep admin access protected.'}
        </p>
      </div>
      {done ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <CheckCircle2 className="size-12 text-success" />
          <p className="text-sm font-medium text-success">PIN saved</p>
        </div>
      ) : (
        <PinPad mode="set" onComplete={handleComplete} error={error} loading={loading} />
      )}
      {canSkip && (
        <Button type="button" variant="ghost" size="sm" onClick={onSkip} className="mt-6 text-muted-foreground">
          Skip for now
        </Button>
      )}
    </div>
  )
}

// ── Consent step (risky-capability permissions) ─────────────────────────────────

type ConsentKey = 'uncensored' | 'internet' | 'companions' | 'liability'

interface ConsentDefinition { key: ConsentKey; label: string; risk: string; ifDenied: string }

interface ConsentState {
  uncensored: boolean
  internet: boolean
  companions: boolean
  liability: boolean
  acceptedAt: string | null
  version: number
}

interface ConsentResponse { consents: ConsentState; definitions: ConsentDefinition[]; version: number }

function ConsentToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors', checked ? 'bg-brand' : 'bg-muted')}>
      <span className={cn('pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-lg ring-0 transition-transform', checked ? 'translate-x-5' : 'translate-x-0')} />
    </button>
  )
}

function ConsentStep({ onNext }: { onNext: () => void }) {
  const [definitions, setDefinitions] = useState<ConsentDefinition[]>([])
  const [consents, setConsents] = useState<ConsentState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/consent', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d: ConsentResponse | null) => {
        if (!d) { setError('Could not load permissions.'); return }
        setDefinitions(d.definitions); setConsents(d.consents)
      })
      .catch(() => setError('Could not load permissions.'))
      .finally(() => setLoading(false))
  }, [])

  const set = (key: ConsentKey, value: boolean) => setConsents((c) => (c ? { ...c, [key]: value } : c))

  async function continueNext() {
    if (!consents) return
    setSaving(true); setError('')
    try {
      await fetch('/api/consent', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          uncensored: consents.uncensored, internet: consents.internet,
          companions: consents.companions, liability: consents.liability, accept: true,
        }),
      })
      onNext()
    } catch { setError('Could not save your choices.'); setSaving(false) }
  }

  if (loading) {
    return (
      <div className="flex w-full flex-col items-center justify-center gap-3 py-16">
        <Spinner size="lg" />
        <p className="text-sm text-muted-foreground">Loading permissions…</p>
      </div>
    )
  }
  if (!consents) return <p className="text-sm text-destructive py-8">{error || 'Permissions unavailable.'}</p>

  // Liability is presented as a required acceptance, separate from the capability toggles.
  const toggles = (['uncensored', 'internet', 'companions'] as ConsentKey[])
    .map((key) => definitions.find((d) => d.key === key))
    .filter((d): d is ConsentDefinition => !!d)
  const liability = definitions.find((d) => d.key === 'liability')

  return (
    <div className="w-full space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div>
        <h2 className="text-title">What you allow</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You're in control. Leaving any of these off keeps that feature in its safe default - you can change them anytime in Admin → Security.
        </p>
      </div>

      <div className="space-y-3">
        {toggles.map((def) => (
          <div key={def.key} className="flex items-start gap-3 rounded-card border border-border bg-card px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-tight">{def.label}</p>
              <p className="mt-1 text-xs text-muted-foreground leading-snug">{def.risk}</p>
              <p className="mt-1 text-[11px] text-muted-foreground/70 leading-snug">{def.ifDenied}</p>
            </div>
            <ConsentToggle checked={consents[def.key]} onChange={(v) => set(def.key, v)} />
          </div>
        ))}
      </div>

      {liability && (
        <button type="button" onClick={() => set('liability', !consents.liability)}
          className={cn('flex w-full items-start gap-3 rounded-card border px-4 py-3.5 text-left transition-colors',
            consents.liability ? 'border-brand/40 bg-brand/10' : 'border-warning/40 bg-warning/5')}>
          <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-control border-2 transition-all',
            consents.liability ? 'border-brand bg-brand' : 'border-warning/60 bg-transparent')}>
            {consents.liability && <CheckCircle2 className="size-3.5 text-brand-foreground" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">{liability.label}</p>
            <p className="mt-1 text-xs text-muted-foreground leading-snug">{liability.risk}</p>
            <p className="mt-1 text-[11px] text-muted-foreground/70 leading-snug">{liability.ifDenied}</p>
          </div>
        </button>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-end">
        <Button type="button" onClick={continueNext} disabled={saving || !consents.liability} size="xl">
          {saving ? <Spinner className="text-current" /> : <>Continue <ChevronRight className="size-4" /></>}
        </Button>
      </div>
      {!consents.liability && (
        <p className="text-right text-[11px] text-muted-foreground/70 -mt-3">
          Accept the use-at-your-own-risk waiver to continue.
        </p>
      )}
    </div>
  )
}

// ── Area step (location + units) ────────────────────────────────────────────────

const CURRENCIES = [
  { value: 'USD', label: 'USD - US Dollar' }, { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - British Pound' }, { value: 'CAD', label: 'CAD - Canadian Dollar' },
  { value: 'AUD', label: 'AUD - Australian Dollar' }, { value: 'JPY', label: 'JPY - Japanese Yen' },
  { value: 'CHF', label: 'CHF - Swiss Franc' }, { value: 'CNY', label: 'CNY - Chinese Yuan' },
  { value: 'INR', label: 'INR - Indian Rupee' }, { value: 'MXN', label: 'MXN - Mexican Peso' },
  { value: 'BRL', label: 'BRL - Brazilian Real' }, { value: 'KRW', label: 'KRW - South Korean Won' },
]

interface LocaleSettings { measurement: 'metric' | 'imperial'; temperature: 'celsius' | 'fahrenheit'; currency: string; timeFormat: '12h' | '24h' }

function ToggleGroup<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void
}) {
  return (
    <div className="flex gap-2">
      {options.map(opt => (
        <button key={opt.value} type="button" onClick={() => onChange(opt.value)}
          className={cn('flex-1 rounded-control border px-4 py-2.5 text-sm font-medium transition-all',
            value === opt.value
              ? 'border-brand/50 bg-brand/10 text-brand'
              : 'border-border bg-card text-muted-foreground hover:border-border/80 hover:text-foreground')}>
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function AreaStep({ onNext }: { onNext: () => void }) {
  const { location, status, error: locError, detect, setManual, clear } = useUserLocation()
  const [query, setQuery] = useState('')
  const [locale, setLocale] = useState<LocaleSettings>({ measurement: 'imperial', temperature: 'fahrenheit', currency: 'USD', timeFormat: '12h' })
  // Prefill from the saved locale so revisiting (Back) keeps the chosen units.
  useEffect(() => {
    fetch('/api/admin/locale', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: Partial<LocaleSettings> | null) => { if (d && d.measurement) setLocale(s => ({ ...s, ...d })) })
      .catch(() => {})
  }, [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const detecting = status === 'detecting'

  useEffect(() => { if (!location && status === 'idle') detect() }, [])

  async function continueNext() {
    setSaving(true); setError('')
    try {
      await fetch('/api/admin/locale', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(locale),
      })
      onNext()
    } catch { setError('Could not save preferences.') } finally { setSaving(false) }
  }

  return (
    <div className="w-full space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div>
        <h2 className="text-title">Your area</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Powers local weather, news, maps, and your daily briefing. Stored only on your server.
        </p>
      </div>

      {/* Location */}
      <div className="space-y-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Location</p>
        {location ? (
          <div className="flex items-center gap-3 rounded-card border border-success/30 bg-success/5 px-4 py-3">
            <MapPin className="size-4 shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{location.displayName}</p>
              <p className="text-xs text-muted-foreground">Saved · you can change this anytime in Settings</p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => clear()} className="shrink-0 text-muted-foreground">
              Change
            </Button>
          </div>
        ) : (
          <>
            <Button type="button" variant="tinted" size="xl" onClick={detect} disabled={detecting} className="w-full">
              {detecting ? <Spinner className="text-current" /> : <Navigation className="size-4" />}
              Use my current location
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground/50">
              <div className="h-px flex-1 bg-border" /> or enter it <div className="h-px flex-1 bg-border" />
            </div>
            <form onSubmit={(e) => { e.preventDefault(); if (query.trim()) setManual(query.trim()) }} className="flex gap-2">
              <input className={inputCls} placeholder="City or ZIP code" value={query} onChange={e => setQuery(e.target.value)} />
              <Button type="submit" variant="outline" disabled={detecting || !query.trim()} className="shrink-0">
                Set
              </Button>
            </form>
            {locError && <p className="text-xs text-warning/80">{locError}</p>}
          </>
        )}
      </div>

      {/* Units */}
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Measurement</p>
          <ToggleGroup value={locale.measurement} onChange={v => setLocale(s => ({ ...s, measurement: v }))}
            options={[{ value: 'imperial', label: 'Imperial (mi, ft, lb)' }, { value: 'metric', label: 'Metric (km, m, kg)' }]} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Temperature</p>
            <ToggleGroup value={locale.temperature} onChange={v => setLocale(s => ({ ...s, temperature: v }))}
              options={[{ value: 'fahrenheit', label: '°F' }, { value: 'celsius', label: '°C' }]} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Time</p>
            <ToggleGroup value={locale.timeFormat} onChange={v => setLocale(s => ({ ...s, timeFormat: v }))}
              options={[{ value: '12h', label: '12h' }, { value: '24h', label: '24h' }]} />
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Currency</p>
          <select value={locale.currency} onChange={e => setLocale(s => ({ ...s, currency: e.target.value }))} className={inputCls}>
            {CURRENCIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={onNext} className="text-muted-foreground">Skip location</Button>
        <Button type="button" onClick={continueNext} disabled={saving} size="xl">
          {saving ? <Spinner className="text-current" /> : <>Continue <ChevronRight className="size-4" /></>}
        </Button>
      </div>
    </div>
  )
}

// ── Components (models) step - preserved logic, restyled header ─────────────────

interface ModelsStepProps {
  onNext: (modelIds: string[], componentIds: string[], tier: string, ollamaInstalled: boolean) => void
  initialTier?: string
  initialIds?: string[]
  initialComponents?: string[] | null
}

const LLM_ROLES: ModelRole[] = ['llm', 'uncensored_llm']

function defaultsForTier(models: CatalogEntry[], tier: string): string[] {
  return models
    .filter((m) => m.tiers.includes(tier) && m.recommended)
    .map((m) => m.id)
}

function ModelsStep({ onNext, initialTier, initialIds, initialComponents }: ModelsStepProps) {
  const [catalog, setCatalog]         = useState<CatalogResponse | null>(null)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState('')
  const [selectedTier, setTier]       = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // Default to all capabilities selected; users uncheck what they don't want.
  // On revisit, restore the previously chosen capabilities.
  const [selectedComponents, setSelectedComponents] = useState<string[]>(() => initialComponents ?? CAPABILITIES.map((c) => c.id))
  const [ollamaRunning, setOllamaRunning] = useState(false)
  // On Windows we can't auto-install Ollama, so track whether a system binary exists and
  // gate the install until it's running or installed (the wizard prompts the user otherwise).
  const [ollamaInstalled, setOllamaInstalled] = useState(true)
  // Default to a compact summary; the full per-model/feature editor is behind "Customize".
  const [customizing, setCustomizing] = useState(false)

  // Sticky header stacking: the step title pins to the top, category headers pin
  // directly under it. Measure the title so categories know their top offset.
  const titleRef = useRef<HTMLDivElement>(null)
  const [titleH, setTitleH] = useState(0)
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    const measure = () => setTitleH(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loading])

  function toggleComponent(cap: Capability) {
    setSelectedComponents((prev) => {
      const adding = !prev.includes(cap.id)
      if (adding && cap.requires.some((r) => !prev.includes(r))) return prev
      let next = adding ? [...prev, cap.id] : prev.filter((x) => x !== cap.id)
      if (!adding) {
        const dependents = CAPABILITIES.filter((c) => c.requires.includes(cap.id)).map((c) => c.id)
        next = next.filter((x) => !dependents.includes(x))
      }
      // wakeword-train always travels with wakeword-core
      if (cap.id === 'wakeword-core') {
        next = adding
          ? next.includes('wakeword-train') ? next : [...next, 'wakeword-train']
          : next.filter((x) => x !== 'wakeword-train')
      }
      // enabling voice-core auto-adds wakeword-core (and wakeword-train) so hands-free works out of the box
      if (cap.id === 'voice-core' && adding) {
        if (!next.includes('wakeword-core')) next = [...next, 'wakeword-core']
        if (!next.includes('wakeword-train')) next = [...next, 'wakeword-train']
      }
      return next
    })
  }

  useEffect(() => {
    fetch('/api/setup/catalog')
      .then((r) => r.json())
      .then((data: CatalogResponse) => {
        setCatalog(data); setOllamaRunning(data.ollamaRunning); setOllamaInstalled(data.ollamaInstalled)
        const tier = initialTier || data.recommendedTier
        setTier(tier)
        // Restore prior selections on revisit; otherwise pick the tier defaults.
        setSelectedIds(initialIds && initialIds.length ? initialIds : defaultsForTier(data.models, tier))
      })
      .catch(() => setError('Could not load model catalog.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      fetch('/api/setup/ollama-status').then((r) => r.json()).then((d: { running: boolean; installed?: boolean }) => {
        setOllamaRunning(d.running)
        if (typeof d.installed === 'boolean') setOllamaInstalled(d.installed)
      }).catch(() => setOllamaRunning(false))
    }, 3000)
    return () => clearInterval(id)
  }, [])

  function onTierChange(tier: string) {
    if (!catalog) return
    setTier(tier); setSelectedIds(defaultsForTier(catalog.models, tier))
  }

  function toggle(model: CatalogEntry) {
    const { id, role } = model
    if (model.required && !LLM_ROLES.includes(role)) return
    if (LLM_ROLES.includes(role)) {
      if (selectedIds.includes(id)) return
      const nextModel = catalog?.models.find((m) => m.id === id)
      const currentLlmId = selectedIds.find((x) => { const m = catalog?.models.find((c) => c.id === x); return m && LLM_ROLES.includes(m.role) })
      const currentLlm = catalog?.models.find((m) => m.id === currentLlmId)
      setSelectedIds((prev) => {
        let next = prev.filter((x) => { const m = catalog?.models.find((c) => c.id === x); return !m || !LLM_ROLES.includes(m.role) })
        if (nextModel?.builtinVision) next = next.filter((x) => { const m = catalog?.models.find((c) => c.id === x); return m?.role !== 'vision' })
        if (currentLlm?.builtinVision && !nextModel?.builtinVision) {
          const defaultVision = catalog?.models.find((m) => m.role === 'vision' && m.tiers.includes(selectedTier))
          if (defaultVision && !next.includes(defaultVision.id)) next = [...next, defaultVision.id]
        }
        return [...next, id]
      })
      return
    }
    setSelectedIds((prev) => {
      const adding = !prev.includes(id)
      if (adding && (model.requires ?? []).some(r => !prev.includes(r))) return prev
      let next = adding ? [...prev, id] : prev.filter((x) => x !== id)
      for (const linkedId of (model.linkedWith ?? [])) {
        if (adding && !next.includes(linkedId)) next = [...next, linkedId]
        if (!adding) next = next.filter((x) => x !== linkedId)
      }
      if (!adding && catalog) {
        const children = catalog.models.filter(m => m.requires?.includes(id))
        for (const child of children) next = next.filter(x => x !== child.id)
      }
      return next
    })
  }

  const [expandedDetails, setExpandedDetails] = useState<string | null>(null)
  const [expandedChange, setExpandedChange]   = useState<string | null>(null)
  function toggleDetails(roleKey: string) { setExpandedDetails((p) => (p === roleKey ? null : roleKey)); setExpandedChange(null) }
  function toggleChange(roleKey: string) { setExpandedChange((p) => (p === roleKey ? null : roleKey)); setExpandedDetails(null) }

  if (loading) {
    return (
      <div className="flex w-full flex-col items-center justify-center gap-3 py-16">
        <Spinner size="lg" />
        <p className="text-sm text-muted-foreground">Detecting hardware…</p>
      </div>
    )
  }
  if (error || !catalog) return <p className="text-sm text-destructive py-8">{error || 'Catalog unavailable.'}</p>

  const tierModels = ROLE_ORDER
    .filter((role) => !LLM_ROLES.includes(role))
    .map((role) => catalog.models.find((m) => m.role === role && m.tiers.includes(selectedTier)))
    .filter((m): m is CatalogEntry => !!m)
  const chatModels  = tierModels.filter((m) => CHAT_ROLES.has(m.role))
  const imageModels = tierModels.filter((m) => IMAGE_GEN_ROLES.has(m.role))
  const voiceModels = tierModels.filter((m) => m.role === 'voice')
  const llmCandidates = catalog.models.filter((m) => LLM_ROLES.includes(m.role) && m.tiers.includes(selectedTier))
  const activeLlmId = selectedIds.find((id) => llmCandidates.some((m) => m.id === id))
  const activeLlm   = llmCandidates.find((m) => m.id === activeLlmId)
  const selectedVision = !activeLlm?.builtinVision ? catalog.models.find((m) => m.role === 'vision' && selectedIds.includes(m.id)) : null
  const selectedImage = catalog.models.find((m) => m.role === 'image_gen' && selectedIds.includes(m.id))
  const selectedCoding = catalog.models.find((m) => m.role === 'coding' && selectedIds.includes(m.id))
  const hotModelBytes = (activeLlm?.approxBytes ?? 0) + (selectedVision?.approxBytes ?? 0) + (selectedImage?.approxBytes ?? 0)
  const hotParts = [activeLlm?.label, !activeLlm?.builtinVision && selectedVision ? 'Vision' : null, selectedImage ? 'Image Gen' : null].filter(Boolean)
  const hotModelLabel = hotParts.join(' + ')

  function ModelRow({ roleKey, label, model, allModels, checked, radio, required, blocked, icon: Icon }: {
    roleKey: string; label: string; model: CatalogEntry; allModels?: CatalogEntry[]
    checked: boolean; radio?: boolean; required?: boolean; blocked?: boolean
    icon?: React.ComponentType<{ className?: string }>
  }) {
    const detailsOpen = expandedDetails === roleKey
    const changeOpen  = expandedChange  === roleKey
    const hasAlts     = (allModels?.length ?? 0) > 1
    const requiresLabel = blocked && model.requires?.length ? catalog?.models.find(m => m.id === model.requires![0])?.label ?? null : null
    return (
      <div className={cn('rounded-card border bg-card transition-colors', blocked ? 'border-border opacity-50' : checked ? 'border-brand/30' : 'border-border')}>
        <div className="flex items-center gap-3 px-4 py-3">
          <button type="button" onClick={() => toggle(model)} disabled={(required && !radio) || blocked}
            className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
              checked ? 'border-brand bg-brand' : 'border-border bg-transparent hover:border-brand/60',
              ((required && !radio) || blocked) && 'cursor-not-allowed')}>
            {radio ? checked && <div className="size-2 rounded-full bg-brand-foreground" /> : checked && <CheckCircle2 className="size-3 text-brand-foreground" />}
          </button>
          {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">{label}</span>
              {required && <span className="text-[10px] font-semibold text-brand shrink-0">Required</span>}
              {radio && <span className="text-[10px] font-semibold text-brand shrink-0">Choose one</span>}
            </div>
            <p className="text-sm font-semibold leading-tight truncate">{model.label}</p>
            {requiresLabel && <p className="text-[10px] text-warning/80 mt-0.5">Requires {requiresLabel}</p>}
          </div>
          <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">~{formatBytes(model.approxBytes)}</span>
          <div className="flex w-28 shrink-0 items-center justify-end gap-1">
            <button type="button" onClick={() => toggleDetails(roleKey)}
              className={cn('flex items-center gap-0.5 rounded-control px-2 py-1 text-xs transition-colors',
                detailsOpen ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5')}>
              details <ChevronDown className={cn('size-3 transition-transform', detailsOpen && 'rotate-180')} />
            </button>
            {hasAlts && (
              <button type="button" onClick={() => toggleChange(roleKey)}
                className={cn('rounded-control px-2 py-1 text-xs transition-colors',
                  changeOpen ? 'bg-brand/20 text-brand' : 'text-muted-foreground hover:text-brand hover:bg-brand/10')}>
                change
              </button>
            )}
          </div>
        </div>
        {detailsOpen && (
          <div className="border-t border-border/50 px-4 py-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
            <p className="text-xs text-muted-foreground leading-relaxed">{model.description}</p>
            <div className="flex flex-wrap gap-1.5">
              {model.format && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{model.format}</span>}
              {model.backendLabel && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{model.backendLabel}</span>}
              {model.tags.map((tag) => <span key={tag} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{tag}</span>)}
            </div>
          </div>
        )}
        {changeOpen && allModels && (
          <div className="border-t border-border/50 px-4 py-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">{radio ? 'Choose one' : 'Select model'}</p>
            {allModels.map((alt) => {
              const isAltActive = selectedIds.includes(alt.id)
              return (
                <button key={alt.id} type="button" onClick={() => { toggle(alt); if (radio) setExpandedChange(null) }}
                  className={cn('w-full rounded-control border px-3 py-2.5 text-left transition-all',
                    isAltActive ? 'border-brand/40 bg-brand/8' : 'border-border bg-background/50 hover:border-border/80 hover:bg-accent/30')}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{alt.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{alt.description}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-xs tabular-nums text-muted-foreground">~{formatBytes(alt.approxBytes)}</span>
                      {isAltActive && <CheckCircle2 className="size-3.5 text-brand" />}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="w-full space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div ref={titleRef} className="sticky top-0 z-20 -mx-6 glass-chrome px-6 pb-3 pt-1 sm:-mx-10 sm:px-10">
        <h2 className="text-title">Choose your AI</h2>
        <p className="mt-1 text-sm text-muted-foreground">Pick the models and features to install. You can add more anytime from Admin → Features.</p>
      </div>

      {/* Compact summary (default) */}
      {!customizing && (
        <div className="rounded-card border border-border bg-card p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">What you'll install</p>
              <p className="text-xs text-muted-foreground">Tuned for your {catalog.hardware.totalRamGb} GB{catalog.hardware.isAppleSilicon ? ' Apple Silicon' : ''} computer. Tweak anything if you like.</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setCustomizing(true)} className="shrink-0">
              <Settings2 className="size-3.5" /> Customize
            </Button>
          </div>
          {(() => {
            const items: { label: string; note?: string }[] = [{ label: 'Chat' }]
            if (activeLlm?.builtinVision || selectedVision) items.push({ label: 'Sees images', note: activeLlm?.builtinVision ? 'built in' : undefined })
            if (selectedImage) items.push({ label: 'Image & video generation' })
            if (selectedCoding) items.push({ label: 'Coding' })
            if (selectedComponents.includes('tesseract')) items.push({ label: 'Home Inventory' })
            if (selectedComponents.includes('voice-core')) items.push({ label: 'Voice (speak & listen)' })
            if (selectedComponents.includes('wakeword-core')) items.push({ label: 'Wake word' })
            return (
              <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                {items.map((it) => (
                  <div key={it.label} className="flex items-baseline gap-2 text-sm">
                    <CheckCircle2 className="size-3.5 shrink-0 translate-y-0.5 text-success" />
                    <span className="font-medium">{it.label}</span>
                    {it.note && <span className="truncate text-xs text-muted-foreground">{it.note}</span>}
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}

      {/* Full editor (behind Customize) */}
      {customizing && (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Customize models &amp; features</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => setCustomizing(false)} className="text-muted-foreground">Done</Button>
        </div>

        {/* Model size */}
        <div className="space-y-1.5 rounded-card border border-border bg-card px-4 py-3">
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Model size</label>
          <select value={selectedTier} onChange={(e) => onTierChange(e.target.value)}
            className="w-full rounded-control border border-border bg-background px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand/40">
            {catalog.tiers.map((t) => (
              <option key={t.id} value={t.id}>{t.label}{t.id === catalog.recommendedTier ? ' (recommended for you)' : ''}</option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground/60">Bigger sizes are smarter but use more memory and respond a little slower.</p>
        </div>

        <div className="space-y-2">
          <p style={{ top: titleH }} className="sticky z-10 -mx-6 glass-chrome px-6 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60 sm:-mx-10 sm:px-10">Chat &amp; Intelligence</p>
          {(() => {
            const ollamaEntry: CatalogEntry = {
              id: 'ollama-runtime', role: 'runtime', label: ollamaRunning ? 'Ollama · running' : 'Ollama',
              description: 'Local AI model server. Runs all LLM, vision, and embedding models on-device.',
              backend: 'huggingface', approxBytes: catalog.ollamaInstallBytes, tags: [], format: 'binary',
              backendLabel: 'GitHub Releases', required: true, installed: ollamaRunning, recommended: true,
              tiers: ['apple-24', 'apple-36', 'pc-32'],
            }
            return <ModelRow roleKey="runtime" label="Runtime" model={ollamaEntry} checked required icon={ROLE_ICONS.runtime} />
          })()}
          {activeLlm && <ModelRow roleKey="llm" label="Language Model" model={activeLlm} allModels={llmCandidates} checked radio icon={ROLE_ICONS[activeLlm.role]} />}
          {chatModels.filter((m) => !(m.role === 'vision' && activeLlm?.builtinVision)).map((m) => (
            <ModelRow key={m.role} roleKey={m.role} label={ROLE_LABELS[m.role]} model={m}
              allModels={catalog.models.filter((c) => c.role === m.role && c.tiers.includes(selectedTier))}
              checked={selectedIds.includes(m.id)} required={m.required || m.role === 'embeddings' || m.role === 'router'} icon={ROLE_ICONS[m.role]} />
          ))}
          {activeLlm?.builtinVision && (
            <div className="rounded-card border border-brand/20 bg-brand/5 px-4 py-3 flex items-start gap-3">
              <Eye className="size-4 shrink-0 text-brand mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-brand">Vision built in</p>
                <p className="text-xs text-muted-foreground mt-0.5">{activeLlm.label} understands images natively - no separate vision model needed. Saves ~3.3 GB.</p>
              </div>
            </div>
          )}
        </div>

        {imageModels.length > 0 && (
          <div className="space-y-2">
            <p style={{ top: titleH }} className="sticky z-10 -mx-6 glass-chrome px-6 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60 sm:-mx-10 sm:px-10">Image Generation</p>
            <div className="flex items-center gap-3 rounded-card border border-border/50 bg-muted/30 px-4 py-2.5">
              <Server className="size-4 shrink-0 text-muted-foreground/60" />
              <div className="min-w-0 flex-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">Runtime</span>
                <p className="text-sm text-muted-foreground">ComfyUI · included automatically</p>
              </div>
            </div>
            {imageModels.map((m) => (
              <ModelRow key={m.role} roleKey={m.role} label={ROLE_LABELS[m.role]} model={m}
                allModels={catalog.models.filter((c) => c.role === m.role && c.tiers.includes(selectedTier))}
                checked={selectedIds.includes(m.id)} required={!!m.required}
                blocked={(m.requires ?? []).some(r => !selectedIds.includes(r))} icon={ROLE_ICONS[m.role]} />
            ))}
          </div>
        )}

        {voiceModels.length > 0 && (
          <div className="space-y-2">
            <p style={{ top: titleH }} className="sticky z-10 -mx-6 glass-chrome px-6 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60 sm:-mx-10 sm:px-10">Voice</p>
            {voiceModels.map((m) => (
              <ModelRow key={m.role} roleKey={m.role} label={ROLE_LABELS[m.role]} model={m}
                allModels={catalog.models.filter((c) => c.role === m.role && c.tiers.includes(selectedTier))}
                checked={selectedIds.includes(m.id)} icon={ROLE_ICONS[m.role]} />
            ))}
          </div>
        )}

        {(() => {
          const baseApps  = CAPABILITIES.filter(c => c.base)
          const extraCaps = CAPABILITIES.filter(c => !c.base)
          function CapRow({ cap }: { cap: Capability }) {
            const checked = selectedComponents.includes(cap.id)
            const blocked = cap.requires.some((r) => !selectedComponents.includes(r))
            const Icon    = cap.icon
            const requiresLabel = blocked ? CAPABILITIES.find((c) => c.id === cap.requires[0])?.label ?? null : null
            return (
              <div className={cn('rounded-card border bg-card transition-colors', blocked ? 'border-border opacity-50' : checked ? 'border-brand/30' : 'border-border')}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <button type="button" onClick={() => toggleComponent(cap)} disabled={blocked}
                    className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
                      checked ? 'border-brand bg-brand' : 'border-border bg-transparent hover:border-brand/60', blocked && 'cursor-not-allowed')}>
                    {checked && <CheckCircle2 className="size-3 text-brand-foreground" />}
                  </button>
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-tight">{cap.label}</p>
                    <p className="text-xs text-muted-foreground leading-tight truncate">{cap.description}</p>
                    {requiresLabel && <p className="text-[10px] text-warning/80 mt-0.5">Requires {requiresLabel}</p>}
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">~{formatBytes(cap.bytes)}</span>
                </div>
              </div>
            )
          }
          return (
            <>
              <div className="space-y-2">
                <p style={{ top: titleH }} className="sticky z-10 -mx-6 glass-chrome px-6 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60 sm:-mx-10 sm:px-10">Base Applications</p>
                {baseApps.map(cap => <CapRow key={cap.id} cap={cap} />)}
              </div>
              <div className="space-y-2">
                <p style={{ top: titleH }} className="sticky z-10 -mx-6 glass-chrome px-6 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60 sm:-mx-10 sm:px-10">More capabilities</p>
                <p className="px-1 text-xs text-muted-foreground/70 -mt-1">Optional - you can also add these later from Admin → Features.</p>
                {extraCaps.map(cap => <CapRow key={cap.id} cap={cap} />)}
              </div>
            </>
          )
        })()}
      </div>
      )}

      {(() => {
        const ollamaBytes  = ollamaRunning ? 0 : catalog.ollamaInstallBytes
        const freeBytes    = catalog.disk.freeBytes
        const componentBytes = selectedComponents.reduce((sum, id) => { const cap = CAPABILITIES.find((c) => c.id === id); return cap ? sum + cap.bytes : sum }, 0)
        const toDownloadBytes = selectedIds.reduce((sum, id) => { const m = catalog.models.find((x) => x.id === id); return m && !m.installed ? sum + m.approxBytes : sum }, 0) + ollamaBytes + componentBytes
        const notEnough  = freeBytes > 0 && toDownloadBytes > freeBytes * 0.95
        const canProceed = selectedIds.length > 0 && !notEnough
        return (
          <div className="rounded-card border border-border bg-card px-4 py-4 space-y-3">
            {customizing ? (
              <ResourceBars totalRamGb={catalog.hardware.totalRamGb} hotModelBytes={hotModelBytes} hotModelLabel={hotModelLabel}
                diskTotalBytes={catalog.disk.totalBytes} diskFreeBytes={freeBytes} toDownloadBytes={toDownloadBytes} />
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-muted-foreground"><span className="font-semibold text-foreground tabular-nums">{formatBytes(toDownloadBytes)}</span> to download</span>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-muted-foreground"><span className="font-semibold text-foreground tabular-nums">{formatBytes(Math.max(0, freeBytes - toDownloadBytes))}</span> free afterward</span>
                <span className={cn('ml-auto inline-flex items-center gap-1 text-xs font-medium', notEnough ? 'text-warning' : 'text-success')}>
                  {notEnough ? <><AlertTriangle className="size-3.5" /> Not enough space</> : <><CheckCircle2 className="size-3.5" /> Enough space</>}
                </span>
              </div>
            )}
            <div className="flex justify-end pt-1">
              <Button type="button" onClick={() => {
                onNext(selectedIds, selectedComponents, selectedTier, ollamaRunning)
              }} disabled={!canProceed} size="xl">
                Continue <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ── Download step (essentials only) ─────────────────────────────────────────────

interface DownloadStepProps {
  modelIds: string[]; componentIds: string[]; tier: string; ollamaInstalled: boolean
  onComplete: () => void
}

const OLLAMA_RUNTIME_ID = 'ollama-runtime'
const ESSENTIAL_LLM_ROLES = new Set<ModelRole>(['llm', 'uncensored_llm'])

const ROLE_FRIENDLY: Partial<Record<string, string>> = {
  llm:            'Chat Engine',
  uncensored_llm: 'Chat Engine',
  vision:         'Vision Model',
  embeddings:     'Memory Engine',
  router:         'Smart Router',
  router_llm:     'Smart Router',
  image_gen:      'Image Generator',
  face_id:        'Face Recognition',
  face_embed:     'Face Profiles',
  video_motion:   'Video Motion',
  video_gen:      'Video Generator',
  bg_remove:      'Background Remover',
  voice:          'Voice Engine',
}

const COMPONENT_FRIENDLY: Record<string, string> = {
  'voice-core':         'Voice Engine',
  'wakeword-core':      'Wake Word',
  'wakeword-train':     'Wake Word Trainer',
  'kiwix-tools':        'Books & References',
  'tesseract':          'Text Recognition',
  'maps-toolchain':     'Maps Engine',
  'weather-icons':      'Weather Icons',
  'comfyui-facerestore':'Face Restore',
  'codeformer':         'Face Enhancer',
  'gfpgan':             'Portrait Enhancer',
  'esrgan':             'Upscaler Model',
}

const RUNTIME_FRIENDLY: Record<string, string> = {
  'ollama-runtime':   'AI Runtime',
  'comfyui-base':     'Image Runtime',
  'comfyui-nodes':    'Image Extensions',
  'taesd':            'Live Preview Engine',
  'sdxl-vae':         'Color Corrector',
  'esrgan-upscaler':  'Upscaler',
}

function dlTitle(d: ModelDownload) {
  if (d.role === 'component') return COMPONENT_FRIENDLY[d.id] ?? d.label
  if (d.role === 'runtime')   return RUNTIME_FRIENDLY[d.id]   ?? d.label
  return ROLE_FRIENDLY[d.role] ?? d.label
}
function dlSubtitle(d: ModelDownload) {
  if (d.role === 'component') return COMPONENT_FRIENDLY[d.id] ? d.label : undefined
  if (d.role === 'runtime')   return RUNTIME_FRIENDLY[d.id]   ? d.label : undefined
  return ROLE_FRIENDLY[d.role] ? d.label : undefined
}

function DownloadStep({ modelIds, componentIds, tier, ollamaInstalled, onComplete }: DownloadStepProps) {
  const [downloads, setDownloads] = useState<Map<string, ModelDownload>>(() => {
    const m = new Map<string, ModelDownload>()
    // Only the essentials install inline here (Ollama + chat LLM + embeddings + router);
    // the backend filters by role and enqueues everything else to run after boot. Model
    // rows appear as their 'start' events arrive, so we just seed the runtime.
    if (!ollamaInstalled) m.set(OLLAMA_RUNTIME_ID, { id: OLLAMA_RUNTIME_ID, role: 'runtime', label: 'Ollama Runtime', status: 'pending', completed: 0, total: 0, speedBps: 0, etaSeconds: 0 })
    return m
  })
  const [showDetails, setShowDetails] = useState(false)
  const [allDone, setAllDone] = useState(false)
  const [runKey, setRunKey]   = useState(0)
  const abortRef              = useRef<AbortController | null>(null)
  const esRefs                = useRef<Set<EventSource>>(new Set())  // open archive/map streams
  const erroredRef            = useRef(false)  // a RETRIABLE item failed this round
  const retryTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryAttemptRef       = useRef(0)
  const itemFailsRef          = useRef<Map<string, number>>(new Map())  // per-item failure count
  const [autoRetrying, setAutoRetrying] = useState(false)

  const MAX_ITEM_ATTEMPTS = 3
  const isRetriable = (id: string) => (itemFailsRef.current.get(id) ?? 0) < MAX_ITEM_ATTEMPTS
  // Record a failure for one item and flag the round for retry only while the item still
  // has attempts left. Past the cap the item is given up on (terminal) so one broken
  // download (a dead mirror, a bad catalog entry) can't retry forever or block finishing.
  function noteFail(id: string): boolean {
    const n = (itemFailsRef.current.get(id) ?? 0) + 1
    itemFailsRef.current.set(id, n)
    const retriable = n < MAX_ITEM_ATTEMPTS
    if (retriable) erroredRef.current = true
    return retriable
  }
  // Backend reachability comes from the app-wide poller so we don't double-probe.
  // Every download event also feeds reportAlive() so the (connection-starved) probe
  // doesn't false-alarm while streams are flowing.
  const { reachable, reportAlive } = useServerHealth()
  const serverDown = !reachable

  function setDl(id: string, patch: Partial<ModelDownload>) {
    setDownloads((prev) => {
      const next = new Map(prev)
      const cur  = next.get(id) ?? { id, role: 'llm' as ModelRole, label: id, status: 'pending' as const, completed: 0, total: 0, speedBps: 0, etaSeconds: 0 }
      next.set(id, { ...cur, ...patch })
      return next
    })
  }

  // NOTE: ZIMs and maps no longer download in the wizard - only the essentials install
  // here (Ollama + chat LLM + embeddings + router). The backend enqueues everything else
  // to the background download-job manager, which runs after the app boots and is surfaced
  // by the global BackgroundSetupWidget. See plans/background-downloads/README.md.

  useEffect(() => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    erroredRef.current = false
    setAutoRetrying(false)

    // On retry, requeue the essential model rows that exist but didn't finish (and are
    // still within budget). Model rows are created by the stream's 'start' events, and
    // the backend re-filters to essentials, so we only need to reset existing rows.
    if (runKey > 0) {
      for (const [id, d] of downloads) {
        if (d.status !== 'completed' && isRetriable(id)) setDl(id, { status: id === OLLAMA_RUNTIME_ID ? 'pending' : 'idle', completed: 0, total: 0 })
      }
    }

    let streamCancelled = false
    async function runModelStream(): Promise<void> {
      // Send the full selection but flag essentialOnly: the backend installs just the
      // essentials inline (streamed here) and enqueues the rest (other models, extra
      // components) to the background job manager. Offline content (library, maps,
      // home-inventory OCR) is chosen later in the post-boot welcome wizard.
      const res = await fetch('/api/setup/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, modelIds, componentIds, essentialOnly: true }), signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        const r = noteFail('setup-request')
        setDl('setup-request', { role: 'runtime', label: 'Setup', status: 'error', error: r ? 'Request failed' : `Request failed - skipped after ${MAX_ITEM_ATTEMPTS} tries` })
        return
      }
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let currentEvent = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) currentEvent = line.slice(6).trim()
          else if (line.startsWith('data:')) {
            reportAlive()  // model stream is flowing → backend is up
            const raw = line.slice(5).trim()
            if (!raw || raw === '{}') { if (currentEvent === 'done') return; continue }
            try {
              const d = JSON.parse(raw) as { id: string; role: ModelRole; label: string; status?: string; completed?: number; total?: number; speedBps?: number; etaSeconds?: number; error?: string }
              if (currentEvent === 'queued') setDl(d.id, { id: d.id, role: d.role, label: d.label, status: 'idle', completed: 0, total: 0, speedBps: 0, etaSeconds: 0 })
              else if (currentEvent === 'start') setDl(d.id, { id: d.id, role: d.role, label: d.label, status: 'downloading', completed: 0, total: 0, speedBps: 0, etaSeconds: 0 })
              else if (currentEvent === 'progress') setDl(d.id, { status: 'downloading', completed: d.completed ?? 0, total: d.total ?? 0, speedBps: d.speedBps ?? 0, etaSeconds: d.etaSeconds ?? 0, note: d.status ?? undefined })
              else if (currentEvent === 'complete') setDl(d.id, { status: 'completed' })
              else if (currentEvent === 'error') { const r = noteFail(d.id); setDl(d.id, { status: 'error', error: r ? d.error : `${d.error ?? 'Failed'} - skipped after ${MAX_ITEM_ATTEMPTS} tries` }) }
              else if (currentEvent === 'cancelled') { streamCancelled = true; return }
              else if (currentEvent === 'done') return
            } catch { /* malformed */ }
          }
        }
      }
    }

    async function runAll() {
      try {
        // Essentials only - Ollama + chat LLM + embeddings + router. Everything else
        // (extra models, ZIMs, maps, components) is enqueued by the backend to the
        // background job manager and finishes after the app boots.
        await runModelStream()
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        erroredRef.current = true
      }
      if (ctrl.signal.aborted || streamCancelled) return
      if (erroredRef.current) {
        // Auto-retry incomplete items with exponential backoff (capped). No button:
        // transient failures recover on their own, and a down backend is retried until
        // it returns. A completed item is skipped on the next round, so progress sticks.
        retryAttemptRef.current += 1
        const delay = Math.min(2000 * 2 ** (retryAttemptRef.current - 1), 15000)
        setAutoRetrying(true)
        retryTimerRef.current = setTimeout(() => { setAutoRetrying(false); setRunKey((k) => k + 1) }, delay)
      } else {
        retryAttemptRef.current = 0
        setAllDone(true)  // only when everything actually completed
      }
    }

    // Defer the kickoff one tick. React StrictMode (dev) mounts effects twice
    // (mount → cleanup → mount); without this the install would fire twice and
    // spawn duplicate concurrent downloads (duplicate Ollama pulls + 409 storms
    // on archives) that hammered the backend. The cleanup cancels the first tick
    // so only the surviving mount actually starts.
    let disposed = false
    const startTimer = setTimeout(() => {
      if (disposed) return
      runAll().catch((err) => { if (err instanceof DOMException && err.name === 'AbortError') return; console.error('Download error:', err) })
    }, 0)
    return () => {
      disposed = true
      clearTimeout(startTimer)
      ctrl.abort()
      for (const es of esRefs.current) es.close()
      esRefs.current.clear()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey])

  // LLM failure is fatal: the app can't chat without it. Block auto-navigation and
  // force a retry instead of opening a broken app.
  const llmFailed = allDone && [...downloads.values()].some(
    d => ESSENTIAL_LLM_ROLES.has(d.role) && d.status === 'error',
  )

  useEffect(() => {
    if (allDone && !llmFailed) { const t = setTimeout(onComplete, 1200); return () => clearTimeout(t) }
  }, [allDone, llmFailed, onComplete])

  function cancel() {
    abortRef.current?.abort()
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null }
    setAutoRetrying(false)
    for (const es of esRefs.current) es.close()
    esRefs.current.clear()
    for (const [id] of downloads) if (downloads.get(id)?.status !== 'completed') setDl(id, { status: 'cancelled' })
  }
  // Resume after a manual cancel: re-run everything not yet completed (partial files resume on the backend).
  function resume() { setAllDone(false); retryAttemptRef.current = 0; itemFailsRef.current.clear(); setRunKey((k) => k + 1) }

  const allItems    = [...downloads.values()]
  const totalCount  = allItems.length
  const completedCount = allItems.filter((d) => d.status === 'completed').length
  const cancelled      = allItems.some((d) => d.status === 'cancelled')
  // Items we've permanently given up on (past the retry cap) - they no longer drive
  // any "retrying" messaging; they're reported once at the end as "couldn't download".
  const skippedCount   = allItems.filter((d) => d.status === 'error' && !isRetriable(d.id)).length
  // Only show genuinely-moving rows: hide the split-second pre-connection limbo.
  const activeItems = allItems.filter((d) => d.status === 'downloading' && d.note !== 'Waiting to start…')
  // Overall = completed items + the current items' fractions, so the bar advances
  // smoothly as items download (in parallel) instead of jumping a whole step.
  const activeFraction = activeItems.reduce((s, d) => s + (d.total > 0 ? Math.min(1, d.completed / d.total) : 0), 0)
  const rawPct     = totalCount > 0 ? Math.round(((completedCount + activeFraction) / totalCount) * 100) : 0
  // Cap at 99 until the server fires 'done' - prevents the brief "1 of 1 completed"
  // window (between Ollama finishing and the first model's 'start' event) from locking
  // at 100% before the real items have been added.
  const overallPct = (allDone && skippedCount === 0) ? 100 : Math.min(rawPct, 99)

  return (
    <div className="w-full space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div>
        <h2 className="text-title">Installing your AI</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Downloading everything you selected. Large models like image generation can take a while - grab a coffee.
        </p>
      </div>

      <InstallPromo />

      <div className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="truncate text-lg font-bold tracking-tight">
            {allDone ? (llmFailed ? 'Download failed' : skippedCount > 0 ? 'Ready' : 'Everything is ready') : 'Overall progress'}
          </h3>
          <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
            <span className="font-semibold text-foreground">{overallPct}%</span> · {completedCount} of {totalCount}
          </span>
        </div>
        <div className="relative h-4 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-500',
              allDone ? (llmFailed ? 'bg-destructive' : skippedCount > 0 ? 'bg-warning' : 'bg-success') : undefined)}
            style={{
              width: `${overallPct}%`,
              // Mirrors DownloadProgress's own animated fill for a consistent in-progress treatment.
              ...(!allDone ? {
                background: 'linear-gradient(90deg, var(--gradient-brand-2), var(--gradient-brand-3), var(--gradient-brand-4), var(--gradient-brand-3), var(--gradient-brand-2))',
                backgroundSize: '200% 100%',
                animation: 'dl-gradient 2s linear infinite',
              } : {}),
            }}
          />
        </div>
        {allDone && (
          llmFailed ? (
            <div className="space-y-3 animate-in fade-in">
              <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="size-4 shrink-0" />
                The AI model couldn't download. Check your internet connection and try again.
              </p>
              <div className="flex items-center gap-4">
                <Button type="button" onClick={resume}>
                  Try again <ChevronRight className="size-4" />
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onComplete} className="text-muted-foreground">
                  Skip and open anyway
                </Button>
              </div>
            </div>
          ) : (
            <div className={cn('flex items-center gap-2 text-sm font-medium animate-in fade-in', skippedCount > 0 ? 'text-warning' : 'text-success')}>
              <CheckCircle2 className="size-4" />
              {skippedCount > 0
                ? `Done - ${skippedCount} item${skippedCount === 1 ? '' : 's'} couldn't download (add them later in Admin). Opening app…`
                : 'All done - opening app…'}
            </div>
          )
        )}
      </div>

      {/* Currently-downloading items (parallel): always visible so it never looks stalled. */}
      {!allDone && activeItems.length > 0 && (
        <div className="space-y-2.5">
          {activeItems.map((d) => (
            <DownloadProgress
              key={d.id}
              label={dlTitle(d)}
              description={dlSubtitle(d)}
              status={d.status}
              progress={d.total > 0 ? Math.round((d.completed / d.total) * 100) : undefined}
              downloadedBytes={d.completed}
              totalBytes={d.total}
              speedBps={d.speedBps}
              etaSeconds={d.etaSeconds}
              note={d.note}
            />
          ))}
        </div>
      )}

      <div>
        <button type="button" onClick={() => setShowDetails((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
          {showDetails ? 'Hide details' : 'Show details'}
          <ChevronDown className={cn('size-3.5 transition-transform', showDetails && 'rotate-180')} />
        </button>
        {showDetails && (
          <div className="mt-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-150">
            {allItems.map((dl) => {
              const progress = dl.total > 0 ? Math.round((dl.completed / dl.total) * 100) : undefined
              return <DownloadProgress key={dl.id} label={dlTitle(dl)} description={dlSubtitle(dl)} status={dl.status} progress={progress}
                downloadedBytes={dl.completed} totalBytes={dl.total} speedBps={dl.speedBps} etaSeconds={dl.etaSeconds} error={dl.error} note={dl.note} />
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        {!allDone && cancelled ? (
          // Only a manual cancel needs a button - errors recover on their own.
          <Button type="button" onClick={resume}>
            Resume <ChevronRight className="size-4" />
          </Button>
        ) : !allDone && serverDown ? (
          <p className="flex items-center gap-2 text-sm text-warning">
            <Spinner className="text-current" />
            Can't reach the server. Make sure the backend is running, reconnecting…
          </p>
        ) : !allDone && autoRetrying ? (
          // Only while a retry is actually scheduled - NOT for already-given-up items.
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="text-brand" />
            Hit a snag, retrying automatically...
          </p>
        ) : <div />}
        {!allDone && !cancelled && <Button type="button" variant="ghost" size="sm" onClick={cancel} className="text-muted-foreground">Cancel</Button>}
      </div>
    </div>
  )
}

// ── SetupWizard (main) ──────────────────────────────────────────────────────────

export type WizardStartStep = 'profile' | 'models'

interface SetupWizardProps {
  /** 'profile' = fresh first run; 'models' = admin already exists but didn't finish downloads */
  startStep?: WizardStartStep
}

interface SavedState {
  step: Step
  modelIds?: string[]
  componentIds?: string[]
  tier?: string
  ollamaInstalled?: boolean
}

// Fire-and-forget persist of wizard progress so an interruption resumes here.
function saveSetupState(state: SavedState) {
  fetch('/api/setup/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(state),
  }).catch(() => {})
}

export function SetupWizard({ startStep = 'profile' }: SetupWizardProps) {
  const { user, refetch } = useAuth()
  const navigate          = useNavigate()
  const [step, setStep]   = useState<Step>(startStep === 'models' ? 'components' : 'welcome')
  const [adminId, setAdminId] = useState<string | null>(null)
  const [downloadIds, setDownloadIds] = useState<string[]>([])
  const [downloadComponentIds, setDownloadComponentIds] = useState<string[]>([])
  const [downloadTier, setDownloadTier] = useState('')
  const [ollamaInstalled, setOllamaInstalled] = useState(false)
  const [maxIdx, setMaxIdx] = useState(0)
  const restoredRef = useRef(false)

  // Navigate to a step, remembering the furthest reached so the rail can jump back/forward.
  function goTo(s: Step) {
    setStep(s)
    setMaxIdx((m) => Math.max(m, STEP_ORDER.indexOf(s)))
  }

  const userId = adminId ?? user?.id ?? ''

  // Resume: on mount, restore saved progress (step + selections) if setup was
  // interrupted. Jumps straight back into the download when that's where it died.
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    fetch('/api/setup/status', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { firstRunComplete?: boolean; state?: SavedState | null }) => {
        const s = d?.state
        if (!s || d.firstRunComplete || !STEP_ORDER.includes(s.step)) return
        if (s.modelIds) setDownloadIds(s.modelIds)
        if (s.componentIds) setDownloadComponentIds(s.componentIds)
        if (s.tier) setDownloadTier(s.tier)
        if (typeof s.ollamaInstalled === 'boolean') setOllamaInstalled(s.ollamaInstalled)
        setStep(s.step); setMaxIdx(STEP_ORDER.indexOf(s.step))
      })
      .catch(() => {})
  }, [])

  async function handleProfileNext(id: string) { setAdminId(id); await refetch(); goTo('pin') }

  // Offline content (library, maps, OCR) is chosen later in the post-boot welcome wizard,
  // so the install jumps straight to downloading the essentials.
  function handleModelsNext(ids: string[], componentIds: string[], tier: string, ollama: boolean) {
    setDownloadIds(ids); setDownloadComponentIds(componentIds); setDownloadTier(tier); setOllamaInstalled(ollama)
    saveSetupState({ step: 'download', modelIds: ids, componentIds, tier, ollamaInstalled: ollama })
    goTo('download')
  }

  async function handleDownloadComplete() { await refetch(); navigate('/', { replace: true }) }

  const profileInitial = user ? {
    id: user.id, firstName: user.firstName, lastName: user.lastName, nickname: user.nickname,
    avatarUrl: user.avatarUrl, dicebearStyle: user.dicebearStyle, dicebearSeed: user.dicebearSeed, dicebearConfig: user.dicebearConfig,
  } : undefined

  return (
    <WizardShell step={step} onNavigate={goTo} maxIdx={maxIdx}>
      {step === 'welcome'  && <WelcomeStep onNext={() => goTo('profile')} />}
      {step === 'profile'  && <ProfileStep onNext={handleProfileNext} editMode={!!userId} initial={profileInitial} />}
      {step === 'pin' && userId && <PinStep userId={userId} onNext={() => goTo('consent')} onSkip={() => goTo('consent')} canSkip={false} />}
      {step === 'consent'  && <ConsentStep onNext={() => goTo('area')} />}
      {step === 'area'     && <AreaStep onNext={() => goTo('components')} />}
      {step === 'components' && <ModelsStep onNext={handleModelsNext} initialTier={downloadTier} initialIds={downloadIds} initialComponents={downloadComponentIds.length ? downloadComponentIds : null} />}
      {step === 'download' && (
        <DownloadStep
          modelIds={downloadIds} componentIds={downloadComponentIds} tier={downloadTier}
          ollamaInstalled={ollamaInstalled}
          onComplete={handleDownloadComplete}
        />
      )}
    </WizardShell>
  )
}
