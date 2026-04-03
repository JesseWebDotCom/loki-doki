type WakewordSignalVisualizerProps = {
  level: number
  speechLevel: number
  wakewordScore: number
  isActive: boolean
  compact?: boolean
  showLegend?: boolean
}

const BAR_COUNT = 24

export function WakewordSignalVisualizer({
  level,
  speechLevel,
  wakewordScore,
  isActive,
  compact = false,
  showLegend = false,
}: WakewordSignalVisualizerProps) {
  const normalizedLevel = Math.max(0, Math.min(1, level))
  const normalizedSpeech = Math.max(0, Math.min(1, speechLevel))
  const normalizedWakeword = Math.max(0, Math.min(1, wakewordScore))
  const barHeight = compact ? "h-8" : "h-12"

  return (
    <div className="space-y-2">
      <div className={`flex items-end gap-1 rounded-2xl border border-[var(--line)] bg-[var(--panel)] px-3 py-3 ${barHeight}`}>
        {Array.from({ length: BAR_COUNT }, (_, index) => {
          const progress = (index + 1) / BAR_COUNT
          const baseActive = normalizedLevel >= progress
          const speechActive = normalizedSpeech >= progress
          const wakewordActive = normalizedWakeword >= progress
          const color = wakewordActive
            ? "rgba(74, 222, 128, 0.95)"
            : speechActive
              ? "rgba(96, 165, 250, 0.9)"
              : baseActive
                ? "rgba(250, 204, 21, 0.85)"
                : "rgba(127, 138, 157, 0.18)"
          const heightScale = wakewordActive ? 1 : speechActive ? 0.9 : baseActive ? 0.75 : 0.3
          return (
            <span
              key={index}
              className="block flex-1 rounded-full transition-all duration-150"
              style={{
                backgroundColor: color,
                boxShadow: wakewordActive ? "0 0 14px rgba(74, 222, 128, 0.35)" : "none",
                minHeight: compact ? 4 : 5,
                height: `${Math.max(18, progress * 100 * heightScale)}%`,
                opacity: isActive ? 1 : 0.55,
              }}
            />
          )
        })}
      </div>
      {showLegend ? (
        <div className="flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
          <LegendSwatch color="rgba(250, 204, 21, 0.9)" label="Sound" />
          <LegendSwatch color="rgba(96, 165, 250, 0.9)" label="Speech" />
          <LegendSwatch color="rgba(74, 222, 128, 0.95)" label="Wakeword" />
        </div>
      ) : null}
    </div>
  )
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      <span>{label}</span>
    </div>
  )
}
