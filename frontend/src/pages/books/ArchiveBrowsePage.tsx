// Lists individual titles inside an installed offline ZIM pack (Gutenberg,
// Wikibooks, Wikisource, etc.) instead of only offering "open the whole pack and
// search inside it". Backed by /api/archives/browse/:sourceId, which walks the
// ZIM's own title index (backend/zim-server.ts). Real kiwix-serve (Windows) has
// no equivalent listing API, so browsing degrades to "search this archive" there.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { useInstalledArchives } from '@/hooks/useInstalledArchives'
import { browseArchive, type ArchiveBrowseEntry } from '@/lib/books/api'

const PAGE_SIZE = 30

export function ArchiveBrowsePage() {
  const { sourceId = '' } = useParams()
  const navigate = useNavigate()
  const { data: archives = [] } = useInstalledArchives()
  const archive = archives.find((a) => a.sourceId === sourceId)

  const [query, setQuery] = useState('')
  const [inputValue, setInputValue] = useState('')
  const [start, setStart] = useState(0)
  const [results, setResults] = useState<ArchiveBrowseEntry[]>([])
  const [total, setTotal] = useState(0)
  const [unsupported, setUnsupported] = useState(false)
  const [loading, setLoading] = useState(true)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (q: string, s: number) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    const r = await browseArchive(sourceId, { start: s, count: PAGE_SIZE, q })
    if (ctrl.signal.aborted) return
    setResults(r.results)
    setTotal(r.total)
    setUnsupported(r.unsupported ?? false)
    setLoading(false)
  }, [sourceId])

  useEffect(() => { void load(query, start) }, [load, query, start])

  const openEntry = (path: string) => navigate(`/read/${sourceId}?path=${encodeURIComponent(path)}`)

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="pb-16">
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/books/library')}>
          <ArrowLeft className="mr-1.5 size-4" />My Library
        </Button>

        <PageHeader title={archive?.label ?? 'Browse'} eyebrow="Books" subtitle={archive?.description ?? 'Browse titles in this offline library.'} />

        {unsupported ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Search className="size-8 text-muted-foreground/40" />
            <p className="text-sm">Title browsing isn't available on this platform for this archive.</p>
            <Button variant="outline" onClick={() => navigate(`/read/${sourceId}`)}>Open and search inside</Button>
          </div>
        ) : (
          <>
            <div className="flex max-w-lg items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { setStart(0); setQuery(inputValue.trim()) } }}
                  placeholder="Filter titles…"
                  className="ld-input w-full pl-9"
                />
              </div>
              <Button variant="secondary" onClick={() => { setStart(0); setQuery(inputValue.trim()) }}>Filter</Button>
            </div>

            {loading ? (
              <div className="flex justify-center py-16"><Spinner size="lg" /></div>
            ) : results.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No titles match "{query}".</p>
            ) : (
              <>
                <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {results.map((e) => (
                    <Card key={e.path} variant="interactive" className="flex items-center gap-3 p-3" onClick={() => openEntry(e.path)}>
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-[var(--books-accent-soft)]">
                        <BookOpen className="size-4 text-[var(--books-accent-fg)]" />
                      </span>
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">{e.title}</p>
                    </Card>
                  ))}
                </div>

                <div className="mt-6 flex items-center justify-center gap-3">
                  <Button variant="outline" size="sm" disabled={start <= 0} onClick={() => setStart((s) => Math.max(0, s - PAGE_SIZE))}>
                    <ChevronLeft className="mr-1 size-4" />Previous
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {start + 1}–{Math.min(start + PAGE_SIZE, total)} of {total.toLocaleString()}
                  </span>
                  <Button variant="outline" size="sm" disabled={start + PAGE_SIZE >= total} onClick={() => setStart((s) => s + PAGE_SIZE)}>
                    Next<ChevronRight className="ml-1 size-4" />
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </PageContainer>
    </div>
  )
}
