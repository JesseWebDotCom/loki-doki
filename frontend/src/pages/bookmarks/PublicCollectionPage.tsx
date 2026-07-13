import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Globe, ExternalLink, Rss, FolderOpen } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { Spinner } from '@/components/ui/spinner'
import { Card } from '@/components/ui/card'
import { getIconChoice } from '@/components/shared/IconPicker'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { getPublicCollection } from '@/lib/bookmarks/api'

function host(url: string) { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

export function PublicCollectionPage() {
  const { slug = '' } = useParams()
  const { data, isLoading, isError } = useQuery({ queryKey: ['public-collection', slug], queryFn: () => getPublicCollection(slug), retry: false })

  if (isLoading) return <div className="flex min-h-screen items-center justify-center bg-background"><Spinner size="lg" /></div>
  if (isError || !data) {
    return (
      // design-ok(raw-h1-in-pages): standalone unauthenticated page, no app shell / PageHeader
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-background px-6 text-center">
        <FolderOpen className="size-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Collection not found</h1>
        <p className="text-sm text-muted-foreground">This shared collection is private or no longer exists.</p>
      </div>
    )
  }

  const Icon = getIconChoice(data.collection.icon)?.Icon ?? FolderOpen
  const color = data.collection.color ? resolveProjectColor(data.collection.color) : undefined

  return (
    <div className="min-h-screen bg-background">
      {/* design-ok(adhoc-container): standalone public page, intentionally not the app PageContainer */}
      {/* design-ok(raw-h1-in-pages): standalone unauthenticated page, no app shell / PageHeader */}
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-card bg-accent/60"><Icon className="size-6" style={color ? { color } : undefined} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold">{data.collection.name}</h1>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Globe className="size-3.5" />Shared collection · {data.items.length} link{data.items.length === 1 ? '' : 's'}</p>
          </div>
          <a href={`/api/bookmarks/public/${slug}/rss`} className="flex items-center gap-1.5 rounded-control border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground" title="RSS feed">
            <Rss className="size-4" /> RSS
          </a>
        </header>

        {data.items.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">No links in this collection yet.</p>
        ) : (
          <div className="grid gap-2">
            {data.items.map(item => (
              <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer">
                <Card className="group flex items-center gap-3 border-border/60 p-3 transition-colors hover:border-border">
                  {item.faviconUrl
                    ? <img src={proxyImg(item.faviconUrl)} alt="" className="size-5 shrink-0 rounded-[3px] object-contain" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                    : <Globe className="size-5 shrink-0 text-muted-foreground" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium leading-snug">{item.title || item.url}</p>
                    <p className="truncate text-xs text-muted-foreground">{item.siteName || host(item.url)}</p>
                    {item.excerpt && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.excerpt}</p>}
                  </div>
                  <ExternalLink className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </Card>
              </a>
            ))}
          </div>
        )}

        <footer className="mt-10 text-center text-xs text-muted-foreground/60">Shared from a private Loki library.</footer>
      </div>
    </div>
  )
}
