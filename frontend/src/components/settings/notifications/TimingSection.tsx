// "Timing" — quiet hours and the daily-summary send time. (The morning report toggle
// joins this section when digests land.) Times run on the home server's clock.

import { Switch } from '@/components/ui/switch'

export interface QuietHoursPref { enabled: boolean; start: string; end: string }

function TimeInput({ value, onChange, disabled, label }: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  label: string
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      <input
        type="time"
        value={value}
        disabled={disabled}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className="h-8 rounded-md border border-border/60 bg-transparent px-2 text-sm text-foreground disabled:opacity-50"
      />
    </label>
  )
}

export function TimingSection({ quiet, digestTime, onQuietChange, onDigestTimeChange, children }: {
  quiet: QuietHoursPref
  digestTime: string
  onQuietChange: (q: QuietHoursPref) => void
  onDigestTimeChange: (t: string) => void
  children?: React.ReactNode // extra timing rows (morning report)
}) {
  return (
    <section>
      <p className="text-sm font-medium mb-1">Timing</p>
      <p className="text-xs text-muted-foreground mb-4">
        Times use your home server's clock.
      </p>
      <div className="space-y-1">
        <div className="rounded-xl px-3 py-3 hover:bg-muted/40 transition-colors">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Quiet hours</p>
              <p className="text-xs text-muted-foreground">
                Hold non-urgent notifications overnight and deliver them in the morning. Urgent alerts (like security cameras) still come through.
              </p>
            </div>
            <Switch checked={quiet.enabled} onCheckedChange={(v) => onQuietChange({ ...quiet, enabled: v })} />
          </div>
          {quiet.enabled && (
            <div className="mt-2 flex items-center gap-4 pl-0.5">
              <TimeInput label="From" value={quiet.start} onChange={(v) => onQuietChange({ ...quiet, start: v })} />
              <TimeInput label="Until" value={quiet.end} onChange={(v) => onQuietChange({ ...quiet, end: v })} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-4 rounded-xl px-3 py-3 hover:bg-muted/40 transition-colors">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Daily summary time</p>
            <p className="text-xs text-muted-foreground">
              Anything set to "Daily" above arrives as one bundled message at this time.
            </p>
          </div>
          <TimeInput label="" value={digestTime} onChange={onDigestTimeChange} />
        </div>

        {children}
      </div>
    </section>
  )
}
