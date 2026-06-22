// Admin tab for podcast management: shared shows overview and default host config.

import { useEffect, useState } from 'react'
import { Mic, Users, Radio } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'

interface SharedShow {
  id: string
  name: string
  ownerName: string
  style: string
  visibility: 'personal' | 'shared'
}

export function AdminPodcastsTab() {
  const [shows, setShows] = useState<SharedShow[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    const r = await fetch('/api/podcasts/shows', { credentials: 'include' })
    const d = await r.json() as { shows: SharedShow[] }
    setShows(d.shows ?? [])
  }

  useEffect(() => { load().finally(() => setLoading(false)) }, [])

  const shared = shows.filter(s => s.visibility === 'shared')
  const all = shows

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Podcasts</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Overview of all podcast shows. Users manage their own shows from the Podcasts app.
          Shared shows appear in the Family listing for all users.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Shows', value: all.length, icon: Radio },
          { label: 'Shared',      value: shared.length, icon: Users },
        ].map(s => (
          <div key={s.label} className="rounded-lg border border-border/60 bg-card p-3">
            <div className="flex items-center gap-2">
              <s.icon className="size-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </div>
            <p className="text-2xl font-bold mt-1">{loading ? '—' : s.value}</p>
          </div>
        ))}
      </div>

      {/* Shared shows list */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Family Shared Shows</h4>
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
          </div>
        ) : shared.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-10 text-muted-foreground">
            <Mic className="mb-2 size-8 opacity-30" />
            <p className="text-sm">No shared shows yet</p>
            <p className="text-xs mt-1">Users can share their shows from the Podcasts app</p>
          </div>
        ) : (
          <div className="space-y-2">
            {shared.map(show => (
              <div key={show.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-purple-500/15">
                  <Mic className="size-4 text-purple-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{show.name}</p>
                  <p className="text-xs text-muted-foreground">by {show.ownerName} · {show.style}</p>
                </div>
                <div className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                  Shared
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
