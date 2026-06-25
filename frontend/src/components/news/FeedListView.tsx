import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Loader2, CheckCheck, ThumbsUp, ThumbsDown, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/components/shared/NewsCard'
import { listItems, setItemState, markAllRead, sendFeedback, type FeedItem } from '@/lib/feeds/api'

export type FeedScope = 'all' | 'unread' | 'saved'

function FeedThumb({ item }: { item: FeedItem }) {
  if (item.imageUrl) return <img src={proxyImg(item.imageUrl)} alt="" className="size-20 shrink-0 rounded-lg object-cover" loading="lazy" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
  return null
}

// The "power" feed reader, hosted inside News as the All/Unread/Saved scopes. Carries per-item
// read/saved state, the AI interest highlight, and Save-to-Bookmarks (promotes into the library).
export function FeedListView({ scope }: { scope: FeedScope }) {
  const qc = useQueryClient()
  const navigate = useNavigate()

  const itemQuery = useMemo(() => {
    if (scope === 'saved') return { saved: '1' as const }
    if (scope === 'unread') return { unread: '1' as const }
    return {}
  }, [scope])

  const { data: itemData, isLoading } = useQuery({ queryKey: ['feed-items', itemQuery], queryFn: () => listItems(itemQuery) })
  const items = itemData?.items ?? []

  async function open(item: FeedItem) {
    if (!item.read) void setItemState(item.id, { read: true }).then(() => qc.invalidateQueries({ queryKey: ['feeds'] }))
    navigate(`/news/read/${item.id}`)
  }
  async function toggleSave(e: React.MouseEvent, item: FeedItem) {
    e.stopPropagation()
    await setItemState(item.id, { saved: !item.saved })
    toast.success(item.saved ? 'Removed from Bookmarks' : 'Saved to Bookmarks')
    qc.invalidateQueries({ queryKey: ['feed-items'] })
  }
  async function feedback(e: React.MouseEvent, item: FeedItem, vote: 'up' | 'down') {
    e.stopPropagation()
    await sendFeedback(item.id, vote)
    toast.success(vote === 'up' ? 'More like this' : 'Less like this')
    qc.invalidateQueries({ queryKey: ['feed-items'] })
  }

  if (isLoading) return <div className="flex justify-center py-20 text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>
  if (items.length === 0) return <div className="py-20 text-center text-muted-foreground">No items. {scope === 'saved' ? 'Save an article to keep it here.' : 'Add a feed to get started.'}</div>

  return (
    <div>
      {(scope === 'all' || scope === 'unread') && (
        <div className="mb-2 flex justify-end">
          <Button variant="ghost" size="sm" onClick={async () => { await markAllRead({}); qc.invalidateQueries({ queryKey: ['feeds'] }); qc.invalidateQueries({ queryKey: ['feed-items'] }) }}>
            <CheckCheck className="mr-1.5 size-4" />Mark all read
          </Button>
        </div>
      )}
      <div className="divide-y divide-border/40 rounded-xl border border-border/40">
        {items.map(item => (
          <button key={item.id} onClick={() => open(item)}
            className={cn('group flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-accent/30',
              item.read && 'opacity-55',
              item.score != null && item.score < 0.35 && 'opacity-45',
              item.score != null && item.score > 0.7 && 'border-l-2 border-primary')}>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate font-medium">{item.feedTitle}</span>
                {item.publishedAt && <span>· {relativeTime(item.publishedAt)}</span>}
                {item.score != null && item.score > 0.7 && <span className="inline-flex items-center gap-0.5 text-primary"><Sparkles className="size-3" />For you</span>}
              </div>
              <p className="mb-1 line-clamp-2 font-semibold leading-snug">{item.title}</p>
              {item.summary && <p className="line-clamp-2 text-sm text-muted-foreground">{item.summary}</p>}
            </div>
            <FeedThumb item={item} />
            <div className="flex shrink-0 flex-col items-center gap-1">
              <button onClick={(e) => toggleSave(e, item)} title={item.saved ? 'Saved' : 'Save to Bookmarks'}
                className={cn('rounded-md p-1.5 transition-colors', item.saved ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}>
                <Bookmark className={cn('size-4', item.saved && 'fill-current')} />
              </button>
              <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button onClick={(e) => feedback(e, item, 'up')} title="More like this" className="rounded p-1 text-muted-foreground hover:text-emerald-400"><ThumbsUp className="size-3.5" /></button>
                <button onClick={(e) => feedback(e, item, 'down')} title="Less like this" className="rounded p-1 text-muted-foreground hover:text-red-400"><ThumbsDown className="size-3.5" /></button>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
