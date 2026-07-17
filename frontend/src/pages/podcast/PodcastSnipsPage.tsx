import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Scissors } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { SnipRow } from '@/components/podcast/SnipRow'
import { getSnips, type Snip } from '@/lib/podcast/aiApi'
import { getAppByPath } from '@/lib/appCategories'

/** Every moment this user clipped, grouped by show. Each snip deep-links back to the
 *  episode at its timestamp, and carries the note it wrote into the notes app. */
export function PodcastSnipsPage() {
  const { data: snips = [], isLoading } = useQuery({
    queryKey: ['podcast-snips'],
    queryFn: () => getSnips(),
  })

  const byShow = useMemo(() => {
    const groups = new Map<string, { showName: string; items: Snip[] }>()
    for (const s of snips) {
      const g = groups.get(s.showId) ?? { showName: s.showName, items: [] }
      g.items.push(s)
      groups.set(s.showId, g)
    }
    return [...groups.entries()]
  }, [snips])

  return (
    <PageContainer width="narrow" className="py-2 pb-24">
      <PageHeader title="Snips" subtitle="Moments you clipped, titled and summarized. Tap one to play it back from that second." />

      {isLoading ? null : snips.length === 0 ? (
        <EmptyAppState
          icon={Scissors}
          gradient={getAppByPath('/podcasts')?.gradient}
          title="No snips yet"
          tagline='While an episode with a transcript plays, hit "Clip that" in the player or the transcript panel. The clip gets a title, a summary, and a note you can find later.'
        />
      ) : (
        <div className="space-y-8">
          {byShow.map(([showId, group]) => (
            <section key={showId}>
              <SectionHeader title={group.showName} to={`/podcasts/show/${showId}`} className="mb-2" />
              <div className="space-y-0.5">
                {group.items.map(s => <SnipRow key={s.id} snip={s} />)}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  )
}
