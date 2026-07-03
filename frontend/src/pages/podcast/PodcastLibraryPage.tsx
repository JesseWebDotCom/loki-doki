import { Link } from 'react-router-dom'
import { Plus, Radio } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { getShows, type Show } from '@/lib/podcast/api'
import { ShowCover } from '@/components/podcast/ShowCover'
import { usePodcastUI } from '@/components/podcast/PodcastLayout'
import { SectionHead, CardGridSkeleton } from '@/components/store/SectionHead'
import { Button } from '@/components/ui/button'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'

export function PodcastLibraryPage() {
  const { data: shows = [], isLoading } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const { openCreate } = usePodcastUI()
  // Real podcasts this user subscribes to vs. the AI shows they created.
  const subscriptions = shows.filter(s => s.source === 'rss')
  const mine = shows.filter(s => s.isOwn && s.source !== 'rss')

  return (
    <PageContainer width="wide" className="space-y-9 py-6 pb-24">
      <PageHeader title="Library" className="pt-0 pb-0" actions={
        <Button onClick={openCreate} className="gap-1.5 font-semibold">
          <Plus className="size-4" /> Create New
        </Button>
      } />

      {isLoading ? (
        <CardGridSkeleton />
      ) : subscriptions.length === 0 && mine.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <Radio className="size-10 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">You haven't created any shows yet.</p>
          <button onClick={openCreate} className="text-sm font-medium text-brand hover:underline">Create your first show</button>
        </div>
      ) : (
        <>
          {subscriptions.length > 0 && (
            <section>
              <SectionHead title="Subscriptions" />
              <ShowGrid shows={subscriptions} />
            </section>
          )}
          {mine.length > 0 && (
            <section>
              <SectionHead title="My Shows" />
              <ShowGrid shows={mine} />
            </section>
          )}
        </>
      )}
    </PageContainer>
  )
}

function ShowGrid({ shows }: { shows: Show[] }) {
  return (
    <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
      {shows.map(s => (
        <Link key={s.id} to={`/podcasts/show/${s.id}`} className="group">
          <ShowCover showId={s.id} title={s.name} size={220} fill className="aspect-square w-full" />
          <p className="mt-2 truncate text-sm font-semibold">{s.name}</p>
          {s.source === 'rss' && s.author
            ? <p className="truncate text-xs text-muted-foreground">{s.author}</p>
            : s.description && <p className="line-clamp-2 text-xs text-muted-foreground">{s.description}</p>}
        </Link>
      ))}
    </div>
  )
}
