import { useEffect, useMemo, useState } from 'react'
import { CheckCheck, Loader2, Trash2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useAuth } from '@/context/AuthContext'
import { useNotifications } from '@/hooks/useNotifications'
import { NOTIF_CATEGORIES, notifIcon, notifLabel, timeAgo } from '@/lib/notifications'

const PREF_KEY = 'notifications.muted'

export function SettingsNotificationsTab() {
  const { user } = useAuth()
  const { notifications, loadNotifications, markRead, markAllRead, clearAll } = useNotifications()
  const [muted, setMuted] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  // Load the saved delivery preference + the current history on mount.
  useEffect(() => {
    if (!user?.id) return
    void loadNotifications()
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        const saved = data?.[PREF_KEY]
        if (Array.isArray(saved)) setMuted(saved.filter((x): x is string => typeof x === 'string'))
      })
      .catch(() => {})
  }, [user?.id, loadNotifications])

  const unreadCount = useMemo(() => notifications.filter((n) => n.readAt === null).length, [notifications])

  function persistMuted(next: string[]) {
    setMuted(next)
    if (!user?.id) return
    setSaving(true)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [PREF_KEY]: next }),
    })
      // Re-pull the list so just-muted types disappear (and unmuted ones return) right away.
      .then(() => loadNotifications())
      .finally(() => setSaving(false))
  }

  function toggleCategory(types: string[], enabled: boolean) {
    const set = new Set(muted)
    if (enabled) types.forEach((t) => set.delete(t)) // turning ON = unmute
    else types.forEach((t) => set.add(t))            // turning OFF = mute
    persistMuted([...set])
  }

  return (
    <div className="p-4 space-y-8">
      {/* Delivery preferences */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-medium">Delivery</p>
          {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Choose what you're notified about. Muted types are hidden from the bell and the list below.
        </p>
        <div className="space-y-1">
          {NOTIF_CATEGORIES.map(({ key, label, description, types, Icon }) => {
            const enabled = !types.some((t) => muted.includes(t))
            return (
              <div key={key} className="flex items-center gap-4 rounded-xl px-3 py-3 hover:bg-muted/40 transition-colors">
                <Icon className="size-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <Switch checked={enabled} onCheckedChange={(v) => toggleCategory(types, v)} />
              </div>
            )
          })}
        </div>
      </section>

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
