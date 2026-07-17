import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Play, Search, Sparkles } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { Spinner } from '@/components/ui/spinner'
import { ShowCover } from '@/components/podcast/ShowCover'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { searchTranscripts, type TranscriptSearchResult } from '@/lib/podcast/aiApi'
import { getAppByPath } from '@/lib/appCategories'
import { fmtDate, fmtDuration, fmtTime } from '@/lib/podcast/format'

/** Debounce so a typed query does not fire a search (and an embedding pass) per keystroke. */
const DEBOUNCE_MS = 350

/**
 * "Search everything": full-text search across every transcript in the library,
 * returning episodes with their matched, timestamped snippets. Each snippet plays
 * from that exact moment.
 */
export function PodcastSearchPage() {
  const [params, setParams] = useSearchParams()
  const urlQuery = params.get('q') ?? ''
  const [query, setQuery] = useState(urlQuery)
  const [debounced, setDebounced] = useState(urlQuery)

  useAppHeader({
    query,
    setQuery,
    placeholder: 'Search everything you listen to',
  })

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query.trim())
      // Keep the URL shareable without spamming history on every keystroke.
      setParams(query.trim() ? { q: query.trim() } : {}, { replace: true })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, setParams])

  const { data, isFetching } = useQuery({
    queryKey: ['podcast-transcript-search', debounced],
    queryFn: () => searchTranscripts(debounced),
    enabled: debounced.length >= 2,
  })

  const results = useMemo(() => data?.results ?? [], [data])

  return (
    <PageContainer width="narrow" className="py-2 pb-24">
      <PageHeader
        title="Search everything"
        subtitle="Every word of every transcript in your library. Find the moment, not just the episode."
      />

      {debounced.length < 2 ? (
        <EmptyAppState
          icon={Search}
          gradient={getAppByPath('/podcasts')?.gradient}
          title="Search inside your podcasts"
          tagline="Type anything that was said. Episodes with transcripts are searched word by word, and every result plays from the exact second."
        />
      ) : isFetching && results.length === 0 ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : results.length === 0 ? (
        <EmptyAppState
          icon={Search}
          gradient={getAppByPath('/podcasts')?.gradient}
          title="Nothing matched"
          tagline={`No transcript in your library mentions "${debounced}". Only episodes with a transcript are searchable, so transcribing more of them widens this net.`}
        />
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>{results.length} {results.length === 1 ? 'episode' : 'episodes'}</span>
            {data?.reranked && (
              <span className="inline-flex items-center gap-1"><Sparkles className="size-3" /> Ranked by meaning</span>
            )}
          </div>
          <div className="space-y-4">
            {results.map(r => <SearchResultCard key={r.episodeId} result={r} />)}
          </div>
        </>
      )}
    </PageContainer>
  )
}

function SearchResultCard({ result }: { result: TranscriptSearchResult }) {
  const { play } = usePodcastPlayback()

  function playAt(sec: number) {
    play({
      episodeId: result.episodeId,
      showId: result.showId,
      showName: result.showName,
      title: result.title,
      durationSec: result.durationSec ?? undefined,
      coverUrl: `/api/podcasts/shows/${result.showId}/cover`,
    }, sec)
  }

  return (
    <div className="rounded-card border border-border/60 bg-card p-3">
      <div className="flex items-center gap-3">
        <ShowCover showId={result.showId} title={result.showName} size={40} rounded="rounded-control" className="shrink-0" />
        <Link to={`/podcasts/episode/${result.episodeId}`} className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold hover:underline">{result.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[result.showName, fmtDate(result.publishedAt), result.durationSec ? fmtDuration(result.durationSec) : '']
              .filter(Boolean).join(' · ')}
          </p>
        </Link>
      </div>

      <div className="mt-2 space-y-0.5">
        {result.hits.map((h, i) => (
          <button key={i} onClick={() => playAt(h.startSec)}
            className="group flex w-full gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
            title={`Play from ${fmtTime(h.startSec)}`}>
            <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs font-semibold tabular-nums text-brand">
              <Play className="size-3 fill-current opacity-0 transition-opacity group-hover:opacity-100" />
              {fmtTime(h.startSec)}
            </span>
            <span className="min-w-0 text-xs leading-relaxed text-muted-foreground">
              <SnippetText snippet={h.snippet} />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** FTS5 marks matches with [brackets] (the snippet() delimiters chosen server-side);
 *  render those runs as highlighted text rather than showing the punctuation. */
function SnippetText({ snippet }: { snippet: string }) {
  const parts = useMemo(() => snippet.split(/(\[[^\]]*\])/g).filter(Boolean), [snippet])
  return (
    <>
      {parts.map((p, i) => p.startsWith('[') && p.endsWith(']')
        ? <mark key={i} className="rounded bg-brand/20 px-0.5 text-foreground">{p.slice(1, -1)}</mark>
        : <span key={i}>{p}</span>)}
    </>
  )
}
