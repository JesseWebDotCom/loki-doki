import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ArticleReader } from '@/components/shared/ArticleReader'
import { getItemContent } from '@/lib/feeds/api'

export function FeedReaderPage() {
  const { itemId = '' } = useParams()
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({ queryKey: ['feed-content', itemId], queryFn: () => getItemContent(itemId) })

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 bg-background/80 px-4 py-2.5 backdrop-blur">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)} title="Back"><ArrowLeft className="size-4" /></Button>
        <span className="flex-1 truncate text-sm font-medium">{data?.title ?? ''}</span>
        {data?.url && (
          <a href={data.url} target="_blank" rel="noopener noreferrer" title="Open original"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><ExternalLink className="size-4" /></a>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground"><Loader2 className="size-7 animate-spin" /><p>Loading article…</p></div>
        ) : (
          <ArticleReader title={data?.title} byline={data?.author} siteName={data?.siteName} url={data?.url} contentHtml={data?.contentHtml} readingMins={data?.readingMins} />
        )}
      </div>
    </div>
  )
}
