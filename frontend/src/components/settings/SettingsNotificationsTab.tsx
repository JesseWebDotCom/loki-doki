// Settings → Notifications: channels ("where"), routing matrix ("what to send where"),
// timing (quiet hours + daily summary), and history. Channel plumbing lives in
// ./notifications/*; prefs persist via PATCH /api/users/:id/preferences.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useAuth } from '@/context/AuthContext'
import { useNotifications } from '@/hooks/useNotifications'
import {
  notifIcon, notifLabel, timeAgo,
  type ChannelStatus, type DeliveryChannel, type DeliveryMatrix, type DeliveryMode,
} from '@/lib/notifications'
import { ChannelsSection } from './notifications/ChannelsSection'
import { DeliveryMatrixSection } from './notifications/DeliveryMatrixSection'
import { TimingSection, type QuietHoursPref } from './notifications/TimingSection'

const MUTED_KEY = 'notifications.muted'
const MATRIX_KEY = 'notifications.delivery'
const QUIET_KEY = 'notifications.quiet'
const DIGEST_TIME_KEY = 'notifications.digest_time'

export function SettingsNotificationsTab() {
  const { user } = useAuth()
  const { notifications, loadNotifications, markRead, markAllRead, clearAll } = useNotifications()

  const [channels, setChannels] = useState<ChannelStatus | null>(null)
  const [muted, setMuted] = useState<string[]>([])
  const [matrix, setMatrix] = useState<DeliveryMatrix>({})
  const [quiet, setQuiet] = useState<QuietHoursPref>({ enabled: false, start: '22:00', end: '07:00' })
  const [digestTime, setDigestTime] = useState('18:00')
  const [saving, setSaving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const refreshChannels = useCallback(() => {
    fetch('/api/notify/channels', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<ChannelStatus>) : null))
      .then((data) => { if (data) setChannels(data) })
      .catch(() => {})
  }, [])

  // Load channels + saved prefs + history on mount.
  useEffect(() => {
    if (!user?.id) return
    void loadNotifications()
    refreshChannels()
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (!data) return
        const savedMuted = data[MUTED_KEY]
        if (Array.isArray(savedMuted)) setMuted(savedMuted.filter((x): x is string => typeof x === 'string'))
        const savedMatrix = data[MATRIX_KEY]
        if (savedMatrix && typeof savedMatrix === 'object') setMatrix(savedMatrix as DeliveryMatrix)
        const savedQuiet = data[QUIET_KEY] as Partial<QuietHoursPref> | undefined
        if (savedQuiet && typeof savedQuiet === 'object') {
          setQuiet({ enabled: !!savedQuiet.enabled, start: savedQuiet.start ?? '22:00', end: savedQuiet.end ?? '07:00' })
        }
        const savedDigest = data[DIGEST_TIME_KEY]
        if (typeof savedDigest === 'string') setDigestTime(savedDigest)
      })
      .catch(() => {})
  }, [user?.id, loadNotifications, refreshChannels])

  const persist = useCallback((key: string, value: unknown, after?: () => void) => {
    if (!user?.id) return
    setSaving(true)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    })
      .then(() => after?.())
      .finally(() => setSaving(false))
  }, [user?.id])

  const toggleMuted = (types: string[], enabled: boolean) => {
    const set = new Set(muted)
    if (enabled) types.forEach((t) => set.delete(t)) // ON = unmute
    else types.forEach((t) => set.add(t))
    const next = [...set]
    setMuted(next)
    // Re-pull so just-muted types disappear from the bell + list immediately.
    persist(MUTED_KEY, next, () => void loadNotifications())
  }

  const setMode = (category: string, channel: DeliveryChannel, mode: DeliveryMode) => {
    const next: DeliveryMatrix = { ...matrix, [category]: { ...matrix[category], [channel]: mode } }
    setMatrix(next)
    persist(MATRIX_KEY, next)
  }

  const changeQuiet = (q: QuietHoursPref) => { setQuiet(q); persist(QUIET_KEY, q) }
  const changeDigestTime = (t: string) => { setDigestTime(t); persist(DIGEST_TIME_KEY, t) }

  const unreadCount = useMemo(() => notifications.filter((n) => n.readAt === null).length, [notifications])

  return (
    <div className="p-4 space-y-8">
      <ChannelsSection channels={channels} onRefresh={refreshChannels} />

      <DeliveryMatrixSection
        channels={channels}
        muted={muted}
        matrix={matrix}
        onToggleMuted={toggleMuted}
        onSetMode={setMode}
        saving={saving}
      />

      <TimingSection
        quiet={quiet}
        digestTime={digestTime}
        onQuietChange={changeQuiet}
        onDigestTimeChange={changeDigestTime}
      />

      {/* History */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium">History</p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={unreadCount === 0}
              onClick={() => void markAllRead()}
            >
              <CheckCheck className="size-3.5" /> Mark all read
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
              disabled={notifications.length === 0}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 className="size-3.5" /> Clear all
            </Button>
          </div>
        </div>

        {notifications.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-border/60 text-sm text-muted-foreground">
            No notifications
          </div>
        ) : (
          <div className="space-y-1">
            {notifications.map((n) => {
              const NIcon = notifIcon(n.type)
              const unread = n.readAt === null
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => { if (unread) void markRead(n.id) }}
                  className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
                >
                  <NIcon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm leading-snug">{notifLabel(n)}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{timeAgo(n.createdAt)}</p>
                  </div>
                  {unread && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" />}
                </button>
              )
            })}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all notifications?"
        description="This permanently removes every notification from your list. This can't be undone."
        confirmLabel="Clear all"
        destructive
        onConfirm={() => void clearAll()}
      />
    </div>
  )
}
