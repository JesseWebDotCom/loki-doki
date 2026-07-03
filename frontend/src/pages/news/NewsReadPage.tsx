import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ArticleReader } from '@/components/shared/ArticleReader'
import { getItemContent } from '@/lib/feeds/api'

// Full-screen article reader for a feed item, opened from the News feed scopes.
export function NewsReadPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({ queryKey: ['feed-content', id], queryFn: () => getItemContent(id) })

  return (
    <div className="flex h-full flex-col">
      <div className="glass-chrome sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)} title="Back"><ArrowLeft className="size-4" /></Button>
        <span className="flex-1 truncate text-sm font-medium">{data?.title ?? ''}</span>
        {data?.url && (
          <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
            <a href={data.url} target="_blank" rel="noopener noreferrer" title="Open original" aria-label="Open original"><ExternalLink className="size-4" /></a>
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground"><Spinner size="lg" className="size-7" /><p>Loading article…</p></div>
        ) : (
          <ArticleReader title={data?.title} byline={data?.author} siteName={data?.siteName} url={data?.url} contentHtml={data?.contentHtml} readingMins={data?.readingMins} />
        )}
      </div>
    </div>
  )
}
