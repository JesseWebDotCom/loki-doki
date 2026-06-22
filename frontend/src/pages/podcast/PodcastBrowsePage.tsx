import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Sparkles, Users } from 'lucide-react'
import {
  getShows, getSuggestions, acceptSuggestion, dismissSuggestion,
} from '@/lib/podcast/api'
import { ShowCover } from '@/components/podcast/ShowCover'
import { SectionHead, CardGridSkeleton } from '@/components/store/SectionHead'

export function PodcastBrowsePage() {
  const qc = useQueryClient()
  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const { data: suggestions = [], isLoading } = useQuery({ queryKey: ['podcast-suggestions'], queryFn: getSuggestions })
  const family = shows.filter(s => !s.isOwn && s.visibility === 'shared')

  async function accept(id: string) {
    await acceptSuggestion(id)
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['podcast-suggestions'] }),
      qc.invalidateQueries({ queryKey: ['podcast-shows'] }),
      qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
    ])
  }
  async function dismiss(id: string) {
    await dismissSuggestion(id)
    await qc.invalidateQueries({ queryKey: ['podcast-suggestions'] })
  }

  return (
    <div className="mx-auto max-w-5xl space-y-9 px-6 py-7 pb-24">
      <h1 className="text-2xl font-black tracking-tight">Browse</h1>

      <section>
        <SectionHead title="Suggested Shows" />
        {isLoading ? (
          <CardGridSkeleton count={3} />
        ) : suggestions.length === 0 ? (
          <p className="rounded-xl border border-border/40 bg-card p-6 text-center text-sm text-muted-foreground/70">
            No suggestions right now. Create your own from the Library.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {suggestions.map(sg => (
              <div key={sg.id} className="flex flex-col gap-3 rounded-2xl border border-border/40 bg-card p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-brand"><Sparkles className="size-3.5" /> Suggested</div>
                <p className="text-sm font-bold">{sg.title}</p>
                {sg.description && <p className="line-clamp-2 text-xs text-muted-foreground">{sg.description}</p>}
                <div className="mt-auto flex items-center gap-2 pt-1">
                  <button onClick={() => accept(sg.id)} className="flex items-center gap-1 rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground hover:opacity-90">
                    <Plus className="size-3.5" /> Add Show
                  </button>
                  <button onClick={() => dismiss(sg.id)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {family.length > 0 && (
        <section>
          <SectionHead title="Shared with You" />
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {family.map(s => (
              <Link key={s.id} to={`/podcasts/show/${s.id}`} className="group">
                <ShowCover showId={s.id} title={s.name} size={200} fill className="aspect-square w-full" />
                <p className="mt-2 truncate text-sm font-semibold">{s.name}</p>
                <p className="truncate text-xs text-muted-foreground"><Users className="mr-1 inline size-3" />by {s.ownerName}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
