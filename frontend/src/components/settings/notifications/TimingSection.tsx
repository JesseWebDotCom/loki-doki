// "Timing" — quiet hours, the daily-summary send time, and the morning report.
// Times run on the home server's clock.

import { cn } from '@/lib/cn'
import { Switch } from '@/components/ui/switch'

export interface QuietHoursPref { enabled: boolean; start: string; end: string }

export interface MorningReportPref {
  enabled: boolean
  time: string
  channels: ('push' | 'telegram' | 'email')[]
}

const REPORT_CHANNELS: { key: 'push' | 'telegram' | 'email'; label: string }[] = [
  { key: 'push', label: 'Push' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'email', label: 'Email' },
]

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
        className="h-8 rounded-control border border-border/60 bg-transparent px-2 text-sm text-foreground disabled:opacity-50"
      />
    </label>
  )
}

export function TimingSection({ quiet, digestTime, morningReport, availableChannels, onQuietChange, onDigestTimeChange, onMorningReportChange, children }: {
  quiet: QuietHoursPref
  digestTime: string
  morningReport: MorningReportPref
  availableChannels: ('push' | 'telegram' | 'email')[]
  onQuietChange: (q: QuietHoursPref) => void
  onDigestTimeChange: (t: string) => void
  onMorningReportChange: (m: MorningReportPref) => void
  children?: React.ReactNode
}) {
  return (
    <section>
      <p className="text-sm font-medium mb-1">Timing</p>
      <p className="text-xs text-muted-foreground mb-4">
        Times use your home server's clock.
      </p>
      <div className="space-y-1">
        <div className="rounded-control px-3 py-3 hover:bg-muted/40 transition-colors">
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

        <div className="flex items-center gap-4 rounded-control px-3 py-3 hover:bg-muted/40 transition-colors">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Daily summary time</p>
            <p className="text-xs text-muted-foreground">
              Anything set to "Daily" above arrives as one bundled message at this time.
            </p>
          </div>
          <TimeInput label="" value={digestTime} onChange={onDigestTimeChange} />
        </div>

        <div className="rounded-control px-3 py-3 hover:bg-muted/40 transition-colors">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Morning report</p>
              <p className="text-xs text-muted-foreground">
                One daily briefing: weather, headlines, overnight page-watcher alerts, and your reading queue.
              </p>
            </div>
            <Switch checked={morningReport.enabled} onCheckedChange={(v) => onMorningReportChange({ ...morningReport, enabled: v })} />
          </div>
          {morningReport.enabled && (
            <div className="mt-2 flex flex-wrap items-center gap-4 pl-0.5">
              <TimeInput label="At" value={morningReport.time} onChange={(t) => onMorningReportChange({ ...morningReport, time: t })} />
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Send to</span>
                {REPORT_CHANNELS.filter((c) => availableChannels.includes(c.key)).map((c) => {
                  const on = morningReport.channels.includes(c.key)
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => onMorningReportChange({
                        ...morningReport,
                        channels: on ? morningReport.channels.filter((x) => x !== c.key) : [...morningReport.channels, c.key],
                      })}
                      className={cn('rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                        on ? 'border-transparent bg-brand text-white' : 'border-border text-muted-foreground hover:text-foreground')}
                    >
                      {c.label}
                    </button>
                  )
                })}
                {availableChannels.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">connect a channel above first</span>
                )}
              </div>
            </div>
          )}
        </div>

        {children}
      </div>
    </section>
  )
}
