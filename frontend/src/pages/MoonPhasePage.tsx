import { useState } from 'react'
import { Moon } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { cn } from '@/lib/cn'

// ── Moon phase math (ported from backend/src/tools/moonphase.ts) ───────────────

const SYNODIC_MONTH = 29.530588853
// Jan 6.6 2000 UT - a known new moon (Julian Day)
const KNOWN_NEW_MOON_JD = 2451550.1

function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5
}

function moonAge(date: Date): number {
  const jd = julianDay(date)
  return ((jd - KNOWN_NEW_MOON_JD) % SYNODIC_MONTH + SYNODIC_MONTH) % SYNODIC_MONTH
}

function moonIllumination(age: number): number {
  const half = SYNODIC_MONTH / 2
  const frac =
    age <= half
      ? (1 - Math.cos((age / half) * Math.PI)) / 2
      : (1 + Math.cos(((age - half) / half) * Math.PI)) / 2
  return Math.round(frac * 100)
}

function moonPhaseLabel(age: number): { phase: string; emoji: string } {
  if (age < 1.85)  return { phase: 'New Moon',        emoji: '🌑' }
  if (age < 7.38)  return { phase: 'Waxing Crescent', emoji: '🌒' }
  if (age < 9.22)  return { phase: 'First Quarter',   emoji: '🌓' }
  if (age < 14.77) return { phase: 'Waxing Gibbous',  emoji: '🌔' }
  if (age < 16.61) return { phase: 'Full Moon',        emoji: '🌕' }
  if (age < 22.15) return { phase: 'Waning Gibbous',  emoji: '🌖' }
  if (age < 23.99) return { phase: 'Last Quarter',    emoji: '🌗' }
  return             { phase: 'Waning Crescent',      emoji: '🌘' }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000)
}

function isWaxing(age: number): boolean {
  return age < SYNODIC_MONTH / 2
}

interface NextPhase {
  label: string
  emoji: string
  date: Date
}

function nextPhases(date: Date): NextPhase[] {
  const age = moonAge(date)

  // Phase thresholds within the synodic cycle
  const phases: { label: string; emoji: string; threshold: number }[] = [
    { label: 'New Moon',      emoji: '🌑', threshold: 0 },
    { label: 'First Quarter', emoji: '🌓', threshold: 7.38 },
    { label: 'Full Moon',     emoji: '🌕', threshold: 14.77 },
    { label: 'Last Quarter',  emoji: '🌗', threshold: 22.15 },
  ]

  return phases.map(({ label, emoji, threshold }) => {
    let daysUntil = threshold - age
    if (daysUntil <= 0.5) daysUntil += SYNODIC_MONTH
    return { label, emoji, date: addDays(date, daysUntil) }
  })
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Moon visual ───────────────────────────────────────────────────────────────

// The illumination CSS trick:
// - Outer circle is the lit moon (amber-50)
// - Overlay is a dark circle (bg-background / dark navy) shifted left/right
//   to reveal the illuminated crescent or gibbous shape
// - For waxing: light on right, shadow shifted LEFT (shadow covers left side)
// - For waning: light on left, shadow shifted RIGHT (shadow covers right side)
// translateX value: 0 = fully covered (new moon), size = fully uncovered (full moon)
// At 50% illumination (quarter), shadow edge lines up with center: translateX = 0

function MoonVisual({ age, illumination }: { age: number; illumination: number }) {
  const SIZE = 200
  const waxing = isWaxing(age)

  // illumFrac: 0 = new moon, 1 = full moon
  const illumFrac = illumination / 100

  // Shadow translateX: maps illumination to offset
  // New moon (0%): shadow covers fully, offset = 0 (centered on top of moon)
  // First/last quarter (50%): shadow at center, offset = 0
  // Full moon (100%): shadow is off-screen
  //
  // The shadow circle is same size as the moon.
  // At illumFrac = 0: translateX = 0 (dark circle perfectly overlaps)
  // At illumFrac = 0.5: translateX = SIZE/2 (edge at center)
  // At illumFrac = 1: translateX = SIZE (fully off-screen)
  //
  // For waxing: shift shadow LEFT (negative = left side revealed is dark, right is lit)
  //   Actually: lit side is right for waxing crescent. Shadow sits on top shifted left
  //   to uncover the right. translateX from 0 (new) to SIZE (full) going negative.
  //   Wait: we want shadow to cover the left portion. Shadow shifts to the right to uncover right.
  // Let's think differently:
  //   - illumFrac = 0: shadow translateX = 0 (exactly on top, full cover)
  //   - illumFrac = 0.5 (quarter): shadow translateX = SIZE/2 (edge at center of moon)
  //   - illumFrac = 1 (full): shadow translateX = SIZE (fully off to one side)
  //
  // Waxing: lit side is right, so shadow moves LEFT (negative x)
  // Waning: lit side is left, so shadow moves RIGHT (positive x)

  const offsetMag = illumFrac * SIZE
  const translateX = waxing ? -offsetMag : offsetMag

  return (
    <div
      className="relative shrink-0 rounded-full bg-amber-50 ring-1 ring-white/20 overflow-hidden"
      style={{ width: SIZE, height: SIZE }}
    >
      {/* Shadow overlay */}
      <div
        className="absolute inset-0 rounded-full bg-[#0f172a]"
        style={{ transform: `translateX(${translateX}px)` }}
      />
    </div>
  )
}

// ── Next phases grid ──────────────────────────────────────────────────────────

function NextPhaseCard({ phase }: { phase: NextPhase }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-border/50 bg-card px-4 py-4 text-center">
      <span className="text-2xl">{phase.emoji}</span>
      <p className="text-xs font-semibold text-muted-foreground">{phase.label}</p>
      <p className="text-sm font-bold">{formatDate(phase.date)}</p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const GRADIENT = 'linear-gradient(135deg,#0f172a,#1e293b)'

export function MoonPhasePage() {
  const todayIso = toIsoDate(new Date())
  const [selectedDate, setSelectedDate] = useState(todayIso)

  // Parse selected date as local midnight to avoid timezone drift
  const parsedDate = (() => {
    const [y, m, d] = selectedDate.split('-').map(Number)
    return new Date(y!, m! - 1, d!)
  })()

  const age = moonAge(parsedDate)
  const illumination = moonIllumination(age)
  const { phase, emoji } = moonPhaseLabel(age)
  const ageDays = Math.round(age * 10) / 10
  const phases = nextPhases(parsedDate)
  const isToday = selectedDate === todayIso

  return (
    <PageShell gradient={GRADIENT} GhostIcon={Moon}>
      <PageHeader
        variant="compact"
        title="Moon Phase"
        subtitle={isToday ? 'Tonight' : formatDate(parsedDate)}
        gradient={GRADIENT}
        icon={<Moon className="size-7 text-white" />}
      />

      <div className="flex flex-col items-center gap-8 px-5 pb-10">

        {/* Moon visual + phase info */}
        <div className="flex flex-col items-center gap-5 pt-2">
          <MoonVisual age={age} illumination={illumination} />

          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-2xl font-bold">
              {emoji} {phase}
            </p>
            <p className="text-base text-muted-foreground">{illumination}% illuminated</p>
            <p className="text-sm text-muted-foreground/70">
              Day {ageDays} of {SYNODIC_MONTH.toFixed(1)}
            </p>
          </div>
        </div>

        {/* Next phases */}
        <div className="w-full max-w-md">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Next Phases
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {phases.map((p) => (
              <NextPhaseCard key={p.label} phase={p} />
            ))}
          </div>
        </div>

        {/* Date picker */}
        <div className="w-full max-w-md">
          <label
            htmlFor="moon-date"
            className="mb-2 block text-xs font-semibold uppercase tracking-widest text-muted-foreground"
          >
            Check a different date
          </label>
          <input
            id="moon-date"
            type="date"
            value={selectedDate}
            onChange={(e) => { if (e.target.value) setSelectedDate(e.target.value) }}
            className={cn(
              'w-full rounded-xl border border-border/60 bg-card px-4 py-2.5',
              'text-sm text-foreground outline-none',
              'focus:border-brand focus:ring-1 focus:ring-brand',
              'transition-colors',
            )}
          />
          {!isToday && (
            <button
              onClick={() => setSelectedDate(todayIso)}
              className="mt-2 text-xs text-brand underline-offset-2 hover:underline"
            >
              Back to today
            </button>
          )}
        </div>

      </div>
    </PageShell>
  )
}
