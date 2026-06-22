import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Newspaper, RefreshCw, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { NewsFeature, NewsRow } from '@/components/shared/NewsCard'
import { newsQueryOptions, type NewsType } from '@/lib/news/useNews'
import { usePublishUIContext } from '@/context/UIContextProvider'

function initialTab(): NewsType {
  return new URLSearchParams(window.location.search).get('tab') === 'local' ? 'local' : 'world'
}

export function NewsPage() {
  const [tab, setTab] = useState<NewsType>(initialTab)

  usePublishUIContext({ label: 'News', description: `User is reading ${tab} news.` })

  const { data: items = [], isLoading, isError, refetch } = useQuery(newsQueryOptions(tab))
  const status = isLoading ? 'loading' : isError || items.length === 0 ? 'error' : 'ready'

  const featured = items.slice(0, 3)
  const rest = items.slice(3)

  return (
    <PageShell gradient="linear-gradient(135deg,#1e3a5f,#0f766e)" GhostIcon={Newspaper}>
      <PageHeader
        variant="compact"
        title="News"
        gradient="linear-gradient(135deg,#1e3a5f,#0f766e)"
        icon={<Newspaper className="size-7 text-white" />}
        actions={
          <div className="inline-flex rounded-full border border-white/20 bg-black/20 p-1 backdrop-blur-sm">
            {(['world', 'local'] as NewsType[]).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={tab === t ? 'default' : 'ghost'}
                onClick={() => setTab(t)}
                className={tab !== t ? 'text-white/70 hover:text-white hover:bg-white/10' : ''}
              >
                {t === 'world' ? 'Global' : 'Local'}
              </Button>
            ))}
          </div>
        }
      />
      <div className="px-5 pb-10">

        {status === 'loading' && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <WifiOff className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Couldn't load news right now.</p>
            <button
              onClick={() => refetch()}
              className="flex items-center gap-1.5 text-xs text-brand hover:underline"
            >
              <RefreshCw className="size-3" /> Try again
            </button>
          </div>
        )}

        {status === 'ready' && items.length > 0 && (
          <div className="space-y-8">
            <section className="space-y-3">
              <SectionHeader title="Featured" />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {featured.map((item, i) => (
                  <NewsFeature key={i} item={item} />
                ))}
              </div>
            </section>

            {rest.length > 0 && (
              <section className="space-y-2">
                <SectionHeader title={tab === 'world' ? 'More Headlines' : 'More Local News'} />
                <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {rest.map((item, i) => (
                    <NewsRow key={i} item={item} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </PageShell>
  )
}
