import { useEffect, useRef, useState } from 'react'
import { Sparkles, RotateCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { AiGeneratedBadge } from '@/components/shared/AiGeneratedBadge'
import { Skeleton } from '@/components/ui/skeleton'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { SourcesCard } from '@/components/chat/SourcesCard'
import { streamSearchAnswer, type SearchSource } from '@/lib/webSearchApi'

/**
 * LLM-synthesized overview above the plain link list, google/perplexity-style: a
 * short cited answer over the top web results, streamed live. Wrapped in the same
 * `.ai-ring` treatment CompanionComposer uses while the companion is generating
 * (index.css) instead of a one-off card style, so it visibly "comes alive" using the
 * house's existing AI-activity language.
 */
export function AiOverviewCard({ query }: { query: string }) {
  const [content, setContent] = useState('')
  const [sources, setSources] = useState<SearchSource[]>([])
  const [streaming, setStreaming] = useState(false)
  const [noAnswer, setNoAnswer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!query) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setContent('')
    setSources([])
    setNoAnswer(false)
    setError(null)
    setStreaming(true)

    let acc = ''
    streamSearchAnswer(
      query,
      (s) => setSources(s),
      (token) => { acc += token; setContent(acc) },
      ctrl.signal,
    )
      .then(({ noAnswer: na }) => setNoAnswer(na))
      .catch((err) => { if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : 'Could not generate an AI overview.') })
      .finally(() => { if (!ctrl.signal.aborted) setStreaming(false) })

    return () => ctrl.abort()
    // `nonce` is a manual retry trigger only, it deliberately re-fires this effect
    // without changing `query`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, nonce])

  // Nothing to show: a source-free query or a down/unreachable model. The plain
  // result list on the page is unaffected either way.
  if (noAnswer || error) return null

  return (
    <div className={cn('ai-ring', streaming && 'ai-ring--active')}>
      <div className="rounded-[calc(1rem-1.5px)] bg-card p-5">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand/15">
            <Sparkles className="size-3.5 text-brand" />
          </div>
          <p className="text-sm font-semibold">AI Overview</p>
          <AiGeneratedBadge label="AI generated" tone="brand" />
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            disabled={streaming}
            aria-label="Regenerate"
            title="Regenerate"
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
          >
            <RotateCw className="size-3.5" />
          </button>
        </div>

        {content ? (
          <MarkdownRenderer content={content} isStreaming={streaming} sources={sources} />
        ) : (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}

        {!streaming && sources.length > 0 && (
          <div className="mt-4">
            <SourcesCard sources={sources} />
          </div>
        )}
      </div>
    </div>
  )
}
