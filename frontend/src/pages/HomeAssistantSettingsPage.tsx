import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bot, Home, ShieldCheck, Star, X } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { CompanionAbilitiesCard } from '@/components/shared/CompanionAbilitiesCard'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAuth } from '@/context/AuthContext'
import { AdminHomeAssistantSection } from '@/components/admin/AdminHomeAssistantSection'
import { HomeAssistantConnectionCard } from '@/components/homeassistant/HomeAssistantConnectionCard'
import { ToolConfigFields } from '@/components/shared/ToolConfigFields'
import type { HAEntity } from '@/components/homeassistant/DeviceDetailDialog'
import { cn } from '@/lib/cn'

// design-ok(hex-in-tsx): app-identity gradient data, same shape as the APP_GROUPS registry gradients
const HA_GRADIENT = 'linear-gradient(135deg,#1c1917,#57534e)'

interface AdminUser { id: string; nickname?: string; firstName?: string; role?: string }

// Favorites manager - the user-facing settings content. Starred devices power
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
        <Star className="size-4 text-warning" /> Favorites
      </h2>
      {starred.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No starred devices yet. Open a device in the <Link to="/home-assistant" className="text-brand hover:underline">Home app</Link> and
          tap the star, favorites show up in the Home Favorites widget for quick control.
        </p>
      ) : (
        <div className="space-y-1.5">
          {starred.map((e) => (
            <div key={e.entity_id} className="flex items-center gap-2.5 rounded-control border border-border/60 bg-background/40 px-3 py-2">
              <Star className="size-3.5 shrink-0 fill-current text-warning" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{e.friendly_name}</p>
                <p className="text-[11px] text-muted-foreground">{e.area ?? 'No room'}</p>
              </div>
              <button
                type="button"
                onClick={() => removeFavorite(e.entity_id)}
                title="Remove from favorites"
                className={cn('rounded-control p-1.5 text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive')}
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

// Admin content: server-connection deep link + per-user device permissions.
// Only mounted for admins (the shell shows everyone else a locked notice).
function AdminHaSettingsSection() {
  const [users, setUsers] = useState<AdminUser[]>([])

  useEffect(() => {
    fetch('/api/users', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((us: AdminUser[]) => { if (Array.isArray(us)) setUsers(us.filter((u) => u.role !== 'admin')) })
      .catch(() => {})
  }, [])

  return (
    <div className="space-y-6">
      <HomeAssistantConnectionCard />
      <ToolConfigFields toolId="homeAssistant" onlyKeys={['llm_fallback']} />
      <AdminHomeAssistantSection users={users} />
    </div>
  )
}

// Standard per-app Settings home for Home Assistant: the user-facing favorites
// manager + companion abilities, plus an admin-only section for the server
// connection and per-user device permissions.
const SECTIONS: AppSettingsSection[] = [
  {
    id: 'favorites',
    label: 'Favorites',
    icon: Star,
    content: (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Manage your favorite devices. The server connection, device permissions, and security access (locks and entry
          doors) are managed by an admin.
        </p>
        <FavoritesSection />
      </div>
    ),
  },
  { id: 'companion', label: 'Companion', icon: Bot,         content: <CompanionAbilitiesCard appId="home-assistant" /> },
  { id: 'admin',     label: 'Admin',     icon: ShieldCheck, content: <AdminHaSettingsSection />, adminOnly: true },
]

export function HomeAssistantSettingsPage() {
  usePublishUIContext({ label: 'Home Assistant Settings', description: 'User is on the Home Assistant settings page.' })

  return (
    <AppSettingsShell
      appId="home-assistant"
      icon={Home}
      gradient={HA_GRADIENT}
      sections={SECTIONS}
    />
  )
}
