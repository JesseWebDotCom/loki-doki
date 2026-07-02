// "What to send where" — one row per notification category. The In-app switch drives
// the existing `notifications.muted` pref; each linked channel gets a compact
// Off / Now / Daily segmented control persisted sparsely in `notifications.delivery`.
// Unlinked channels are hidden entirely so the matrix stays small and obvious.

import { cn } from '@/lib/cn'
import { Switch } from '@/components/ui/switch'
import {
  NOTIF_CATEGORIES,
  type ChannelStatus, type DeliveryChannel, type DeliveryMatrix, type DeliveryMode,
} from '@/lib/notifications'

const MODES: { value: DeliveryMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: "Don't send here" },
  { value: 'instant', label: 'Now', hint: 'Send immediately' },
  { value: 'digest', label: 'Daily', hint: 'Bundle into one daily summary' },
]

const CHANNEL_LABELS: Record<DeliveryChannel, string> = {
  push: 'Push',
  telegram: 'Telegram',
  email: 'Email',
}

// Mirrors backend DEFAULT_MATRIX: push on, everything else off until chosen.
function modeFor(matrix: DeliveryMatrix, category: string, channel: DeliveryChannel): DeliveryMode {
  return matrix[category]?.[channel] ?? (channel === 'push' ? 'instant' : 'off')
}

function ModeSelect({ value, onChange }: { value: DeliveryMode; onChange: (m: DeliveryMode) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-border/60 p-0.5">
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          title={m.hint}
          onClick={() => onChange(m.value)}
          className={cn(
            'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
            value === m.value
              ? m.value === 'off' ? 'bg-muted text-muted-foreground' : 'bg-brand text-white'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

export function DeliveryMatrixSection({ channels, muted, matrix, onToggleMuted, onSetMode, saving }: {
  channels: ChannelStatus | null
  muted: string[]
  matrix: DeliveryMatrix
  onToggleMuted: (types: string[], enabled: boolean) => void
  onSetMode: (category: string, channel: DeliveryChannel, mode: DeliveryMode) => void
  saving: boolean
}) {
  const activeChannels: DeliveryChannel[] = [
    ...(channels && channels.push.subscriptions > 0 ? (['push'] as const) : []),
    ...(channels?.telegram?.linked ? (['telegram'] as const) : []),
    ...(channels?.email?.verified ? (['email'] as const) : []),
  ]

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-medium">What to send where</p>
        {saving && <span className="text-[10px] text-muted-foreground">Saving…</span>}
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        In-app controls the bell at the top of the app.
        {activeChannels.length > 0 && <> For connected channels, pick <span className="font-medium">Now</span> for right away or <span className="font-medium">Daily</span> to get one summary a day.</>}
        {activeChannels.length === 0 && <> Connect a channel above to send notifications outside the app.</>}
      </p>

      <div className="space-y-1">
        {NOTIF_CATEGORIES.map(({ key, label, description, types, Icon }) => {
          const inAppOn = !types.some((t) => muted.includes(t))
          return (
            <div key={key} className="rounded-xl px-3 py-3 hover:bg-muted/40 transition-colors">
              <div className="flex items-center gap-4">
                <Icon className="size-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0" title="Show in the app's notification bell">
                  <span className="text-[11px] text-muted-foreground hidden sm:inline">In-app</span>
                  <Switch checked={inAppOn} onCheckedChange={(v) => onToggleMuted(types, v)} />
                </div>
              </div>

              {activeChannels.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 pl-8">
                  {activeChannels.map((channel) => (
                    <div key={channel} className="flex items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground w-14">{CHANNEL_LABELS[channel]}</span>
                      <ModeSelect
                        value={modeFor(matrix, key, channel)}
                        onChange={(mode) => onSetMode(key, channel, mode)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
