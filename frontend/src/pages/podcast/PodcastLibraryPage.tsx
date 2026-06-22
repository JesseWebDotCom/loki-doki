import { Link } from 'react-router-dom'
import { Plus, Radio } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { getShows } from '@/lib/podcast/api'
import { ShowCover } from '@/components/podcast/ShowCover'
import { usePodcastUI } from '@/components/podcast/PodcastLayout'
import { CardGridSkeleton } from '@/components/store/SectionHead'

export function PodcastLibraryPage() {
  const { data: shows = [], isLoading } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const { openCreate } = usePodcastUI()
  const mine = shows.filter(s => s.isOwn)

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-6 py-7 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black tracking-tight">Library</h1>
        <button onClick={openCreate} className="flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground hover:opacity-90">
          <Plus className="size-4" /> Create New
        </button>
      </div>

      {isLoading ? (
        <CardGridSkeleton />
      ) : mine.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <Radio className="size-10 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">You haven't created any shows yet.</p>
          <button onClick={openCreate} className="text-sm font-medium text-brand hover:underline">Create your first show</button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {mine.map(s => (
            <Link key={s.id} to={`/podcasts/show/${s.id}`} className="group">
              <ShowCover showId={s.id} title={s.name} size={220} fill className="aspect-square w-full" />
              <p className="mt-2 truncate text-sm font-semibold">{s.name}</p>
              {s.description && <p className="line-clamp-2 text-xs text-muted-foreground">{s.description}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
