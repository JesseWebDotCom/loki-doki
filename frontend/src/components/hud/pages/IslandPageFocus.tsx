import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, FastForward, Pause, Play, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { CompanionOrb } from '@/components/companion/CompanionOrb'
import { useCompanionEngine } from '@/components/shell/CompanionEngineContext'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { formatCountdown } from '@/lib/time/format'
import { DEFAULT_TIMER_TONE } from '@/lib/time/tones'

// Focus (pomodoro) page over the existing timer engine: sessions are ordinary
// server-backed timers with reserved labels, so completion already rings and
// the companion announces it (TimeAlarmContext). The companion doubles as the
// mascot, shifting to its "working" expression while a session runs.

const FOCUS_LABEL = 'Focus session'
const BREAK_LABEL = 'Focus break'
const FOCUS_SEC = 25 * 60
const BREAK_SEC = 5 * 60

export function IslandPageFocus() {
  const engine = useCompanionEngine()
  const { running, startTimer, pauseTimer, resumeTimer, cancelTimer } = useTimeApp()
  const [sessions, setSessions] = useState(0)

  const run = running.find((t) => t.label === FOCUS_LABEL || t.label === BREAK_LABEL) ?? null
  const isBreak = run?.label === BREAK_LABEL

  // 1s tick while a session runs so the countdown moves.
  const [, setNow] = useState(0)
  useEffect(() => {
    if (!run || run.paused) return
    const t = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [run?.id, run?.paused]) // eslint-disable-line react-hooks/exhaustive-deps

  // Count completions: a focus run that vanishes with (almost) nothing left
  // finished naturally (cancel/skip removes it with time remaining).
  const prevRun = useRef(run)
  useEffect(() => {
    const prev = prevRun.current
    prevRun.current = run
    if (prev && !run && prev.label === FOCUS_LABEL && prev.endsAt - Date.now() < 2000) {
      setSessions((n) => n + 1)
    }
  }, [run])

  const remainingMs = run ? (run.paused ? run.remainingMs : Math.max(0, run.endsAt - Date.now())) : FOCUS_SEC * 1000
  const totalMs = (run?.durationSec ?? FOCUS_SEC) * 1000
  const pct = run ? Math.min(100, Math.max(0, 100 - (remainingMs / totalMs) * 100)) : 0
  const workingExpression = !!run && !run.paused && !isBreak

  const start = (label: string, sec: number) => {
    startTimer({ label, tone: DEFAULT_TIMER_TONE, announce: true, durationSec: sec })
  }
  const skip = () => {
    if (run) cancelTimer(run.id)
    start(isBreak ? FOCUS_LABEL : BREAK_LABEL, isBreak ? FOCUS_SEC : BREAK_SEC)
  }

  const avatar = engine.character ? (
    <CharacterAvatar
      className="pointer-events-none"
      character={engine.character}
      {...engine.avatarProps}
      thinking={engine.avatarProps.thinking || workingExpression}
      size={96}
    />
  ) : (
    <CompanionOrb size={96} active={workingExpression || !engine.sleeping} />
  )

  return (
    <div className="flex h-full items-center gap-6 px-4">
      <span className="shrink-0">{avatar}</span>

      <div className="min-w-0 flex-1">
        <div className="text-4xl font-light tabular-nums text-white/95">{formatCountdown(remainingMs)}</div>
        <div className={cn('text-sm', run ? (isBreak ? 'text-info' : 'text-warning') : 'text-white/50')}>
          {run ? (isBreak ? 'Break time' : run.paused ? 'Paused' : 'Deep work') : 'Ready to focus'}
        </div>

        {/* design-ok(glass-on-plain-bg): progress track inside the black island surface */}
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-warning transition-[width] duration-1000" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-white/45">
          <span>{isBreak ? 'Break' : 'Focus'}</span>
          <span>{Math.ceil(remainingMs / 60000)}m left</span>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Reset"
            title="Reset"
            disabled={!run}
            onClick={() => run && cancelTimer(run.id)}
            // design-ok(glass-on-plain-bg): sits inside the black island surface
            className="size-8 rounded-full text-white/60 hover:bg-white/10 hover:text-white"
          >
            <RotateCcw className="size-4" />
          </Button>
          <Button
            size="icon"
            aria-label={run && !run.paused ? 'Pause' : 'Start'}
            title={run && !run.paused ? 'Pause' : 'Start'}
            onClick={() => {
              if (!run) start(FOCUS_LABEL, FOCUS_SEC)
              else if (run.paused) resumeTimer(run.id)
              else pauseTimer(run.id)
            }}
            className="size-11 rounded-full bg-warning text-black hover:bg-warning/85"
          >
            {run && !run.paused ? <Pause className="size-5" /> : <Play className="size-5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Skip to next phase"
            title="Skip to next phase"
            onClick={skip}
            // design-ok(glass-on-plain-bg): sits inside the black island surface
            className="size-8 rounded-full text-white/60 hover:bg-white/10 hover:text-white"
          >
            <FastForward className="size-4" />
          </Button>
          <span className="ml-auto flex items-center gap-1 text-sm text-white/60">
            <CheckCircle2 className="size-4 text-warning" />
            {sessions}
          </span>
        </div>
      </div>
    </div>
  )
}
