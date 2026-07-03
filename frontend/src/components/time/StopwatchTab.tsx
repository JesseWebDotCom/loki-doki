import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { useNow } from '@/hooks/useNow'
import { formatStopwatch } from '@/lib/time/format'

export function StopwatchTab() {
  const { stopwatch, swStart, swStop, swReset, swLap } = useTimeApp()
  const now = useNow(33)

  const elapsed = stopwatch.accumulatedMs + (stopwatch.running && stopwatch.startedAt ? now - stopwatch.startedAt : 0)
  const started = elapsed > 0 || stopwatch.running

  return (
    <div className="flex flex-col items-center gap-8 py-6">
      <div className="text-6xl font-extralight tabular-nums tracking-tight sm:text-7xl">
        {formatStopwatch(elapsed)}
      </div>

      <div className="flex items-center gap-4">
        {stopwatch.running ? (
          <Button variant="outline" size="lg" className="min-w-24" onClick={swLap}>Lap</Button>
        ) : (
          <Button variant="outline" size="lg" className="min-w-24" onClick={swReset} disabled={!started}>Reset</Button>
        )}
        {stopwatch.running ? (
          <Button size="lg" variant="destructive" className="min-w-24" onClick={swStop}>Stop</Button>
        ) : (
          <Button size="lg" className="min-w-24" onClick={swStart}>{started ? 'Resume' : 'Start'}</Button>
        )}
      </div>

      {stopwatch.laps.length > 0 && (
        <Card className="w-full max-w-sm divide-y divide-border/60 border-border/60">
          {stopwatch.laps.map((cumulative, i) => {
            const prev = i > 0 ? stopwatch.laps[i - 1]! : 0
            return (
              <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm tabular-nums">
                <span className="text-muted-foreground">Lap {i + 1}</span>
                <span className="font-medium">{formatStopwatch(cumulative - prev)}</span>
              </div>
            )
          }).reverse()}
        </Card>
      )}
    </div>
  )
}
