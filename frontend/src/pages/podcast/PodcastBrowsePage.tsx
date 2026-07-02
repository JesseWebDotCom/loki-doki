import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Loader2, Plus, Search, Sparkles, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import {
  getShows, getSuggestions, acceptSuggestion, dismissSuggestion,
  getCharts, searchDirectory, subscribePodcast,
} from '@/lib/podcast/api'
import { ShowCover } from '@/components/podcast/ShowCover'
import { DirectoryCard } from '@/components/podcast/DirectoryCard'
import { SectionHead, CardGridSkeleton } from '@/components/store/SectionHead'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function PodcastBrowsePage() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const q = (params.get('q') ?? '').trim()

  // Debounced search input, synced to ?q= so searches survive navigation.
  const [input, setInput] = useState(q)
  useEffect(() => {
    const t = setTimeout(() => {
      const next = input.trim()
      if (next === q) return
      setParams(next ? { q: next } : {}, { replace: true })
    }, 300)
    return () => clearTimeout(t)
  }, [input]) // eslint-disable-line react-hooks/exhaustive-deps

  const [genreId, setGenreId] = useState<number | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const { data: suggestions = [], isLoading } = useQuery({ queryKey: ['podcast-suggestions'], queryFn: getSuggestions })
  const { data: charts, isLoading: chartsLoading } = useQuery({
    queryKey: ['podcast-dir-charts', genreId],
    queryFn: () => getCharts(genreId),
    enabled: !q,
  })
  const { data: searchResults = [], isFetching: searching } = useQuery({
    queryKey: ['podcast-dir-search', q],
    queryFn: () => searchDirectory(q),
    enabled: !!q,
  })
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
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-black tracking-tight">Browse</h1>
        <button onClick={() => setAddOpen(true)}
          className="flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-muted">
          <Link2 className="size-4" /> Add by RSS URL
        </button>
      </div>

      {/* Directory search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50" />
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Search podcasts…"
          className="w-full rounded-xl border border-border bg-background py-2.5 pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-brand"
        />
      </div>

      {q ? (
        <section>
          <SectionHead title="Directory results" />
          {searching ? (
            <CardGridSkeleton />
          ) : searchResults.length === 0 ? (
            <p className="rounded-xl border border-border/40 bg-card p-6 text-center text-sm text-muted-foreground/70">
              No podcasts found for "{q}".
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {searchResults.map((r, i) => <DirectoryCard key={r.itunesId ?? r.feedUrl ?? i} result={r} />)}
            </div>
          )}
        </section>
      ) : (
        <section>
          <SectionHead title="Top Podcasts" />
          {/* Genre chips */}
          <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
            {[{ id: null as number | null, name: 'Top Podcasts' }, ...(charts?.genres ?? [])].map(g => (
              <button key={g.id ?? 'all'} onClick={() => setGenreId(g.id)}
                className={cn('shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
                  genreId === g.id
                    ? 'border-brand/40 bg-brand/10 text-brand'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')}>
                {g.name}
              </button>
            ))}
          </div>
          {chartsLoading ? (
            <CardGridSkeleton />
          ) : !charts || charts.results.length === 0 ? (
            <p className="rounded-xl border border-border/40 bg-card p-6 text-center text-sm text-muted-foreground/70">
              Charts are unavailable right now. Search for a podcast or add one by RSS URL.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {charts.results.map((r, i) => <DirectoryCard key={r.itunesId ?? r.feedUrl ?? i} result={r} />)}
            </div>
          )}
        </section>
      )}

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

      <AddRssDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}

/** Subscribe to a podcast by pasting its RSS feed URL directly. */
function AddRssDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [url, setUrl] = useState('')
  const [pending, setPending] = useState(false)

  async function handleSubscribe() {
    const feedUrl = url.trim()
    if (!feedUrl) return
    setPending(true)
    try {
      const show = await subscribePodcast({ feedUrl })
      toast.success(`Subscribed to ${show.name}`)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['podcast-subscriptions'] }),
        qc.invalidateQueries({ queryKey: ['podcast-shows'] }),
        qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
      ])
      onOpenChange(false)
      setUrl('')
      navigate(`/podcasts/show/${show.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not subscribe to this feed.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add by RSS URL</DialogTitle>
          <DialogDescription>Paste a podcast's RSS feed URL to subscribe directly.</DialogDescription>
        </DialogHeader>
        <Input
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleSubscribe() }}
          placeholder="https://example.com/feed.xml"
          autoFocus
        />
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void handleSubscribe()} disabled={pending || !url.trim()}>
            {pending && <Loader2 className="size-4 animate-spin" />} Subscribe
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
