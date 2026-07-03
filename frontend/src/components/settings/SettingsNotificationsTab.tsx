// Settings → Notifications: channels ("where"), routing matrix ("what to send where"),
// and timing (quiet hours + daily summary). Notification history/browsing lives in the
// bell dropdown, not here. Channel plumbing lives in ./notifications/*; prefs persist
// via PATCH /api/users/:id/preferences.

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { useNotifications } from '@/hooks/useNotifications'
import {
  type ChannelStatus, type DeliveryChannel, type DeliveryMatrix, type DeliveryMode,
} from '@/lib/notifications'
import { ChannelsSection } from './notifications/ChannelsSection'
import { DeliveryMatrixSection } from './notifications/DeliveryMatrixSection'
import { TimingSection, type MorningReportPref, type QuietHoursPref } from './notifications/TimingSection'

const MUTED_KEY = 'notifications.muted'
const MATRIX_KEY = 'notifications.delivery'
const QUIET_KEY = 'notifications.quiet'
const DIGEST_TIME_KEY = 'notifications.digest_time'
const MORNING_REPORT_KEY = 'notifications.morning_report'

export function SettingsNotificationsTab() {
  const { user } = useAuth()
  const { loadNotifications } = useNotifications()

  const [channels, setChannels] = useState<ChannelStatus | null>(null)
  const [muted, setMuted] = useState<string[]>([])
  const [matrix, setMatrix] = useState<DeliveryMatrix>({})
  const [quiet, setQuiet] = useState<QuietHoursPref>({ enabled: false, start: '22:00', end: '07:00' })
  const [digestTime, setDigestTime] = useState('18:00')
  const [morningReport, setMorningReport] = useState<MorningReportPref>({ enabled: false, time: '07:30', channels: ['push'] })
  const [saving, setSaving] = useState(false)

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
        const savedReport = data[MORNING_REPORT_KEY] as Partial<MorningReportPref> | undefined
        if (savedReport && typeof savedReport === 'object') {
          setMorningReport({
            enabled: !!savedReport.enabled,
            time: savedReport.time ?? '07:30',
            channels: Array.isArray(savedReport.channels) ? savedReport.channels : ['push'],
          })
        }
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
  const changeMorningReport = (m: MorningReportPref) => { setMorningReport(m); persist(MORNING_REPORT_KEY, m) }

  const availableChannels: ('push' | 'telegram' | 'email')[] = [
    ...(channels && channels.push.subscriptions > 0 ? (['push'] as const) : []),
    ...(channels?.telegram?.linked ? (['telegram'] as const) : []),
    ...(channels?.email?.verified ? (['email'] as const) : []),
  ]

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
        morningReport={morningReport}
        availableChannels={availableChannels}
        onQuietChange={changeQuiet}
        onDigestTimeChange={changeDigestTime}
        onMorningReportChange={changeMorningReport}
      />
    </div>
  )
}
