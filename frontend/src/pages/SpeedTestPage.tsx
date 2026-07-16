import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, Download, Globe, Network, Server, Upload, Waves, Zap,
} from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAuth } from '@/context/AuthContext'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { getAppByPath } from '@/lib/appCategories'
import {
  DEFAULT_THRESHOLDS, MODE_META, RATING_META, fmtMbps, fmtMs, loadLastResults, loadThresholds,
  rateSpeed, runSpeedTest, saveLastResults,
  type ResultsByMode, type SpeedMode, type SpeedPhase, type SpeedRating, type SpeedResult, type SpeedThresholds,
} from '@/lib/speedtest'

const GRADIENT = getAppByPath('/speed-test')?.gradient ?? ''
const UPLOAD_COLOR = 'var(--info)'
const NEUTRAL = 'var(--muted-foreground)'
const MODES: SpeedMode[] = ['internet', 'server', 'server-internet']
const MODE_ICON: Record<SpeedMode, typeof Globe> = { internet: Globe, server: Server, 'server-internet': Network }

// Semantic good/ok/bad styling on the design tokens (RATING_META keeps labels).
const RATING_STYLE: Record<SpeedRating, { color: string; text: string; bg: string }> = {
  good: { color: 'var(--success)', text: 'text-success', bg: 'bg-success/10' },
  ok:   { color: 'var(--warning)', text: 'text-warning', bg: 'bg-warning/10' },
  bad:  { color: 'var(--destructive)', text: 'text-destructive', bg: 'bg-destructive/10' },
}

const NOOP = () => {}

const PHASE_LABEL: Record<SpeedPhase, string> = {
  idle: 'Ready', ping: 'Pinging', download: 'Download', upload: 'Upload', done: 'Done',
}

export function SpeedTestPage() {
  const { user } = useAuth()

  usePublishUIContext({
    label: 'Speed Test',
    description: 'User is on the Speed Test page, measuring connection speed.',
  })

  useAppHeader({ query: '', setQuery: NOOP, searchable: false, settingsHref: '/apps/speed-test/settings' })

  return (
    <PageShell>
      <PageContainer className="pb-24">
        <PageHeader subtitle="Measure your real connection speed." />
        <TestPanel userId={user?.id} />
      </PageContainer>
    </PageShell>
  )
}

// ── Scale ladder ──────────────────────────────────────────────────────────────

const SCALE_LADDER = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
function niceScale(v: number): number {
  for (const s of SCALE_LADDER) if (s >= v * 1.08) return s
  return SCALE_LADDER[SCALE_LADDER.length - 1]!
}

function newest(results: ResultsByMode): SpeedResult | null {
  const all = [results.internet, results.server, results['server-internet']].filter(Boolean) as SpeedResult[]
  if (!all.length) return null
  return all.reduce((a, b) => a.at >= b.at ? a : b)
}

// ── Test panel ────────────────────────────────────────────────────────────────

function TestPanel({ userId }: { userId?: string }) {
  const [thresholds, setThresholds] = useState<SpeedThresholds>(DEFAULT_THRESHOLDS)
  const [results, setResults] = useState<ResultsByMode>({ internet: null, server: null, 'server-internet': null })
  const [activeMode, setActiveMode] = useState<SpeedMode | null>(null)
  const [phase, setPhase] = useState<SpeedPhase>('idle')
  const [live, setLive] = useState({ mbps: 0, frac: 0 })
  const running = activeMode !== null
  const runningRef = useRef(false)
  const resultsRef = useRef(results)
  useEffect(() => { resultsRef.current = results }, [results])

  useEffect(() => {
    void loadThresholds().then(setThresholds)
    if (!userId) return
    void loadLastResults(userId).then(setResults)
  }, [userId])

  const run = useCallback(async (modes: SpeedMode[]) => {
    if (runningRef.current) return
    runningRef.current = true
    setLive({ mbps: 0, frac: 0 })
    try {
      for (const m of modes) {
        setActiveMode(m)
        setPhase('ping')
        setLive({ mbps: 0, frac: 0 })
        const res = await runSpeedTest(m, (p) => { setPhase(p.phase); setLive({ mbps: p.mbps, frac: p.frac }) })
        const next: ResultsByMode = { ...resultsRef.current, [m]: res }
        resultsRef.current = next
        setResults(next)
        if (userId) void saveLastResults(userId, next)
        if (res.downloadMbps <= 0 && res.uploadMbps <= 0) {
          toast.error(m === 'internet'
            ? 'Could not reach the Cloudflare speed test. Check your internet connection.'
            : m === 'server-internet'
            ? 'Server internet test failed. Check the server\'s internet connection.'
            : 'Server test failed. Make sure the backend is running.')
        }
      }
    } catch {
      toast.error('Speed test failed. Please try again.')
    } finally {
      setActiveMode(null)
      setPhase('done')
      runningRef.current = false
    }
  }, [userId])

  // Gauge headline: live value of the active run, else the most recent result.
  const isUpload = phase === 'upload'
  const newestResult = newest(results)
  const headline = running ? live.mbps : (newestResult?.downloadMbps ?? 0)
  const rating = !isUpload && headline > 0 ? rateSpeed(headline, thresholds) : null
  const accent = isUpload ? UPLOAD_COLOR : rating ? RATING_STYLE[rating].color : NEUTRAL
  const scaleMax = niceScale(Math.max(
    headline,
    results.internet?.downloadMbps ?? 0, results.server?.downloadMbps ?? 0, results['server-internet']?.downloadMbps ?? 0,
    results.internet?.uploadMbps ?? 0, results.server?.uploadMbps ?? 0,
    thresholds.goodMbps * 1.3, 25,
  ))

  return (
    <div className="grid gap-8 lg:grid-cols-[330px_1fr] lg:items-start">
      {/* Left: gauge + controls */}
      <div className="flex flex-col items-center gap-6">
        <SpeedGauge
          mbps={headline} scaleMax={scaleMax} color={accent} phase={phase} isUpload={isUpload}
          caption={activeMode ? `Testing ${MODE_META[activeMode].label}` : newestResult ? null : 'Ready to test'}
        />

        {running ? <PhaseStepper phase={phase} mode={activeMode} /> : <div className="h-7" />}

        <Button
          size="xl"
          onClick={() => run(MODES)}
          disabled={running}
          className={cn(
            'px-9 text-sm font-bold',
            !running && 'shadow-lg shadow-brand/25 hover:-translate-y-0.5 hover:shadow-brand/40 active:translate-y-0',
          )}
        >
          {running
            ? <><Spinner className="text-current" /> Testing {activeMode ? MODE_META[activeMode].label : ''}… {PHASE_LABEL[phase]}</>
            : <><Zap className="size-4 fill-current" /> {newestResult ? 'Test all again' : 'Run all tests'}</>}
        </Button>
      </div>

      {/* Right: mode cards */}
      <div className="flex w-full flex-col gap-4">
        {MODES.map((m) => (
          <ModeCard
            key={m}
            mode={m}
            result={results[m]}
            thresholds={thresholds}
            active={activeMode === m}
            phase={phase}
            live={live}
            disabled={running}
            onRun={() => run([m])}
          />
        ))}
        <p className="text-[11px] leading-relaxed text-muted-foreground/55">
          <span className="font-semibold text-foreground/70">Internet</span> measures your real ISP speed against
          Cloudflare's edge. <span className="font-semibold text-foreground/70">Server</span> measures private throughput
          from your device to the server. <span className="font-semibold text-foreground/70">Server Internet</span> measures
          the server's own internet connection speed. Speed thresholds are set in Admin → System.
        </p>
      </div>
    </div>
  )
}

// ── Per-mode result card ──────────────────────────────────────────────────────

function ModeCard({ mode, result, thresholds, active, phase, live, disabled, onRun }: {
  mode: SpeedMode; result: SpeedResult | null; thresholds: SpeedThresholds
  active: boolean; phase: SpeedPhase; live: { mbps: number; frac: number }
  disabled: boolean; onRun: () => void
}) {
  const Icon = MODE_ICON[mode]
  const rating = result ? rateSpeed(result.downloadMbps, thresholds) : null
  const dlLive = active && phase === 'download'
  const ulLive = active && phase === 'upload'
  // server-internet has no upload phase
  const hasUpload = mode !== 'server-internet'

  return (
    <Card className={cn(
      'flex flex-col gap-3 p-4 transition-colors',
      active ? 'border-brand/45 ring-1 ring-brand/20' : 'border-border/60',
    )}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-control text-white" style={{ background: GRADIENT }}>
            <Icon className="size-4" />
          </span>
          <div>
            <p className="text-sm font-bold leading-tight">{MODE_META[mode].label}</p>
            <p className="text-[10px] text-muted-foreground/60">{MODE_META[mode].tagline}</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="tinted"
          onClick={onRun}
          disabled={disabled}
          className="font-bold"
        >
          {active
            ? <><Spinner size="sm" className="text-brand" /> {PHASE_LABEL[phase]}</>
            : <><Zap className="size-3 fill-current" /> {result ? 'Retest' : 'Test'}</>}
        </Button>
      </div>

      <div className={cn('grid gap-2', hasUpload ? 'grid-cols-2' : 'grid-cols-3')}>
        <SpeedStatTile icon={Download} label="Download" unit="Mbps" kind="mbps"
          accent={rating ? RATING_STYLE[rating].color : 'var(--info)'}
          ratingClass={result ? RATING_STYLE[rateSpeed(result.downloadMbps, thresholds)].text : undefined}
          live={dlLive} value={dlLive ? live.mbps : result?.downloadMbps ?? null} />
        {hasUpload && (
          <SpeedStatTile icon={Upload} label="Upload" unit="Mbps" kind="mbps" accent={UPLOAD_COLOR}
            live={ulLive} value={ulLive ? live.mbps : result?.uploadMbps ?? null} />
        )}
        <SpeedStatTile icon={Activity} label="Ping" unit="ms" kind="ms" accent="var(--brand)"
          value={result?.pingMs ?? null} />
        <SpeedStatTile icon={Waves} label="Jitter" unit="ms" kind="ms" accent="var(--brand)"
          value={result?.jitterMs ?? null} />
      </div>

      {result && rating && (
        <div className={cn('flex items-center justify-center gap-2 rounded-control py-1.5 text-xs font-semibold', RATING_STYLE[rating].bg, RATING_STYLE[rating].text)}>
          <span className="size-2 rounded-full" style={{ background: RATING_STYLE[rating].color }} />
          Rated {RATING_META[rating].label.toLowerCase()}
        </div>
      )}
    </Card>
  )
}

// ── Speedometer gauge ─────────────────────────────────────────────────────────

const CX = 130
const CY = 130
const R = 104
const START = 135
const SWEEP = 270

function polar(angleDeg: number, r = R): [number, number] {
  const a = (angleDeg * Math.PI) / 180
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)]
}

const ARC_PATH = (() => {
  const [x0, y0] = polar(START)
  const [x1, y1] = polar(START + SWEEP)
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
})()

const TICKS = Array.from({ length: 11 }, (_, i) => i / 10)

function SpeedGauge({ mbps, scaleMax, color, phase, isUpload, caption }: {
  mbps: number; scaleMax: number; color: string; phase: SpeedPhase; isUpload: boolean; caption: string | null
}) {
  const frac = Math.max(0, Math.min(mbps / scaleMax, 1))
  const dotAngle = START + frac * SWEEP
  const pinging = phase === 'ping'

  return (
    <div className="relative grid size-[270px] place-items-center">
      <div
        className={cn('pointer-events-none absolute inset-8 rounded-full blur-2xl transition-opacity duration-500', mbps > 0 ? 'opacity-30' : 'opacity-0')}
        style={{ background: `radial-gradient(circle, ${color}, transparent 70%)` }}
      />

      <svg viewBox="0 0 260 260" className="size-full">
        <defs>
          <linearGradient id="st-arc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.45" />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
          <filter id="st-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Track */}
        <path d={ARC_PATH} fill="none" stroke="currentColor" className="text-foreground/8" strokeWidth="13" strokeLinecap="round" />

        {/* Ticks */}
        {TICKS.map((t, i) => {
          const a = START + t * SWEEP
          const [xo, yo] = polar(a, R + 10)
          const [xi, yi] = polar(a, R + (i % 5 === 0 ? 2 : 5))
          return <line key={i} x1={xi} y1={yi} x2={xo} y2={yo} stroke="currentColor" className="text-foreground/20" strokeWidth={i % 5 === 0 ? 2 : 1} strokeLinecap="round" />
        })}

        {/* Progress */}
        <path d={ARC_PATH} fill="none" stroke="url(#st-arc)" strokeWidth="13" strokeLinecap="round"
          filter="url(#st-glow)" pathLength={100} strokeDasharray="100"
          strokeDashoffset={100 * (1 - frac)} style={{ transition: 'stroke-dashoffset 0.25s ease-out' }} />

        {/* Glowing tip dot (rotates along the arc, never crosses the readout) */}
        <g style={{ transformOrigin: `${CX}px ${CY}px`, transform: `rotate(${dotAngle}deg)`, transition: 'transform 0.25s ease-out' }}>
          <circle cx={CX + R} cy={CY} r="8" fill={color} filter="url(#st-glow)" />
          <circle cx={CX + R} cy={CY} r="3.5" fill="white" />
        </g>

        {/* Scale labels */}
        {[0, 0.5, 1].map((t, i) => {
          const [lx, ly] = polar(START + t * SWEEP, R - 24)
          return (
            <text key={i} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
              className="fill-current text-[9px] font-bold tabular-nums text-muted-foreground/40">
              {Math.round(scaleMax * t)}
            </text>
          )
        })}
      </svg>

      {/* Center readout */}
      <div className="absolute flex flex-col items-center">
        {pinging ? (
          <Spinner className="size-9 text-muted-foreground/50" />
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: mbps > 0 ? color : undefined }}>
              {isUpload ? <Upload className="size-3" /> : <Download className="size-3" />}
              {isUpload ? 'Upload' : 'Download'}
            </div>
            <span className="text-[3.4rem] font-semibold leading-none tabular-nums transition-colors" style={{ color: mbps > 0 ? color : undefined }}>
              {fmtMbps(mbps)}
            </span>
            <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground/55">Mbps</span>
            {caption && <span className="mt-1.5 text-[11px] font-medium text-muted-foreground/60">{caption}</span>}
          </>
        )}
      </div>
    </div>
  )
}

// ── Phase stepper ─────────────────────────────────────────────────────────────

const ALL_STEPS: { phase: SpeedPhase; label: string; icon: typeof Activity }[] = [
  { phase: 'ping', label: 'Ping', icon: Activity },
  { phase: 'download', label: 'Download', icon: Download },
  { phase: 'upload', label: 'Upload', icon: Upload },
]
const ORDER: SpeedPhase[] = ['idle', 'ping', 'download', 'upload', 'done']

function PhaseStepper({ phase, mode }: { phase: SpeedPhase; mode: SpeedMode | null }) {
  const steps = mode === 'server-internet'
    ? ALL_STEPS.filter((s) => s.phase !== 'upload')
    : ALL_STEPS
  const cur = ORDER.indexOf(phase)
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => {
        const idx = ORDER.indexOf(s.phase)
        const state = phase === 'done' || cur > idx ? 'done' : cur === idx ? 'active' : 'pending'
        return (
          <div key={s.phase} className="flex items-center gap-2">
            <div className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-colors',
              state === 'active' && 'bg-brand/15 text-brand ring-1 ring-brand/30',
              state === 'done' && 'bg-success/10 text-success',
              state === 'pending' && 'text-muted-foreground/40',
            )}>
              {state === 'active' ? <Spinner size="sm" className="size-3 text-brand" /> : <s.icon className="size-3" />}
              {s.label}
            </div>
            {i < steps.length - 1 && <div className={cn('h-px w-4', cur > idx ? 'bg-success/40' : 'bg-border')} />}
          </div>
        )
      })}
    </div>
  )
}

// ── Stat tile (animated count-up, or live) ─────────────────────────────────────

function useCountUp(target: number | null, duration = 650): number {
  const [val, setVal] = useState(0)
  const fromRef = useRef(0)
  useEffect(() => {
    if (target == null) { setVal(0); fromRef.current = 0; return }
    let raf = 0
    const start = performance.now()
    const from = fromRef.current
    const tick = (t: number) => {
      const k = Math.min((t - start) / duration, 1)
      const eased = 1 - Math.pow(1 - k, 3)
      const v = from + (target - from) * eased
      setVal(v)
      fromRef.current = v
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return val
}

function SpeedStatTile({ icon: Icon, label, value, unit, kind, accent, live, ratingClass }: {
  icon: typeof Download; label: string; value: number | null; unit: string
  kind: 'mbps' | 'ms'; accent: string; live?: boolean; ratingClass?: string
}) {
  const animated = useCountUp(live ? null : value)
  const shown = live ? (value ?? 0) : animated
  const display = value == null ? '–' : kind === 'mbps' ? fmtMbps(shown) : fmtMs(shown)
  return (
    <div className={cn('relative flex flex-col items-center gap-0.5 overflow-hidden rounded-card border border-border/50 bg-background/40 px-2 py-3', live && 'border-brand/40')}>
      {/* design-ok(adhoc-pulse): live-throughput indicator strip while a test runs */}
      {live && <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse" style={{ background: accent }} />}
      <div className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/55">
        <Icon className="size-3" style={{ color: accent }} />
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className={cn('text-xl font-semibold tabular-nums', ratingClass)} style={!ratingClass && value != null ? { color: accent } : undefined}>
          {display}
        </span>
        <span className="text-[10px] font-semibold text-muted-foreground/55">{unit}</span>
      </div>
    </div>
  )
}
