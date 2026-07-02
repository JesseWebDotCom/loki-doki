import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Home, Lock, ShieldCheck, Star, X } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAuth } from '@/context/AuthContext'
import { AdminHomeAssistantSection } from '@/components/admin/AdminHomeAssistantSection'
import type { HAEntity } from '@/components/homeassistant/DeviceDetailDialog'
import { cn } from '@/lib/cn'

const HA_GRADIENT = 'linear-gradient(135deg,#0f0e17,#1a1625,#0f1923)'

interface AdminUser { id: string; nickname?: string; firstName?: string; role?: string }

// Favorites manager — the user-facing settings content. Starred devices power
// the Home Favorites widget; stars are also togglable from each device's sheet.
function FavoritesSection() {
  const { user } = useAuth()
  const [favorites, setFavorites] = useState<string[]>([])

  const { data } = useQuery({
    queryKey: ['home-assistant-entities'],
    queryFn: async () => {
      const r = await fetch('/api/home-assistant/entities', { credentials: 'include' })
      if (!r.ok) throw new Error('fetch failed')
      return (await r.json()) as { configured: boolean; entities?: HAEntity[] }
    },
  })

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((prefs: Record<string, unknown> | null) => {
        const fav = prefs?.['ha.favorites']
        if (Array.isArray(fav)) setFavorites(fav.filter((v): v is string => typeof v === 'string'))
      })
      .catch(() => {})
  }, [user?.id])

  function removeFavorite(entityId: string) {
    if (!user?.id) return
    const next = favorites.filter((id) => id !== entityId)
    setFavorites(next)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'ha.favorites': next }),
    }).catch(() => {})
  }

  const starred = favorites
    .map((id) => (data?.entities ?? []).find((e) => e.entity_id === id))
    .filter((e): e is HAEntity => !!e)

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Star className="size-4 text-amber-400" /> Favorites
      </h2>
      {starred.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No starred devices yet. Open a device in the <Link to="/home-assistant" className="text-brand hover:underline">Home app</Link> and
          tap the star — favorites show up in the Home Favorites widget for quick control.
        </p>
      ) : (
        <div className="space-y-1.5">
          {starred.map((e) => (
            <div key={e.entity_id} className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-background/40 px-3 py-2">
              <Star className="size-3.5 shrink-0 fill-current text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{e.friendly_name}</p>
                <p className="text-[11px] text-muted-foreground">{e.area ?? 'No room'}</p>
              </div>
              <button
                type="button"
                onClick={() => removeFavorite(e.entity_id)}
                title="Remove from favorites"
                className={cn('rounded-md p-1.5 text-muted-foreground/50 transition-colors hover:bg-red-500/10 hover:text-red-400')}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          <p className="pt-1 text-xs text-muted-foreground">These appear in the Home Favorites widget on your home screen.</p>
        </div>
      )}
    </section>
  )
}

export function HomeAssistantSettingsPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [users, setUsers] = useState<AdminUser[]>([])
  usePublishUIContext({ label: 'Home Assistant Settings', description: 'User is on the Home Assistant settings page.' })

  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/users', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((us: AdminUser[]) => { if (Array.isArray(us)) setUsers(us.filter((u) => u.role !== 'admin')) })
      .catch(() => {})
  }, [isAdmin])

  return (
    <PageShell gradient={HA_GRADIENT} GhostIcon={Home}>
      <div className="mx-auto w-full max-w-xl space-y-6 px-5 pb-12 pt-5">
        <button
          onClick={() => navigate('/home-assistant')}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to Home Assistant
        </button>

        <header className="space-y-1">
          <h1 className="text-xl font-semibold">Home Assistant Settings</h1>
          <p className="text-sm text-muted-foreground">Manage your favorite devices. Server connection and device permissions are managed by an admin.</p>
        </header>

        <FavoritesSection />

        {isAdmin ? (
          <section className="space-y-3 border-t border-border pt-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="size-4 text-violet-400" /> Admin
            </h2>
            <Link to="/admin/integrations/home-assistant" className="inline-flex items-center gap-1.5 text-sm text-violet-400 hover:underline">
              Server connection (URL &amp; access token) <ExternalLink className="size-3.5" />
            </Link>
            <AdminHomeAssistantSection users={users} />
          </section>
        ) : (
          <section className="space-y-2 border-t border-border pt-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <Lock className="size-4" /> Admin
            </h2>
            <p className="text-sm text-muted-foreground">
              The server connection, device permissions, and security access (locks &amp; entry doors) are locked down — ask an admin to change what you can control.
            </p>
          </section>
        )}
      </div>
    </PageShell>
  )
}
