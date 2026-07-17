import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { generateEpisodeInsights, getEpisodeInsights } from '@/lib/podcast/aiApi'
import { transcriptQueryKey } from '@/components/podcast/TranscriptPanel'

/**
 * The pre-listen AI summary: what the episode covers plus its key takeaways, generated
 * from the transcript. Auto-generates once a transcript is ready (the backend chains it
 * onto a finished Whisper run too, so this only fires for feed-provided transcripts).
 */
export function EpisodeSummaryCard({ episodeId, className }: { episodeId: string; className?: string }) {
  const qc = useQueryClient()
  const [generating, setGenerating] = useState(false)
  // One auto-attempt per episode per mount: a model that errors must not spin.
  const autoTried = useRef<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['podcast-insights', episodeId],
    queryFn: () => getEpisodeInsights(episodeId),
  })

  const insights = data?.insights ?? null
  const transcriptReady = data?.transcriptStatus === 'ready'

  async function generate(force = false) {
    setGenerating(true)
    try {
      await generateEpisodeInsights(episodeId, force)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['podcast-insights', episodeId] }),
        // Auto-chapters land in the episode's chapters, which the player reads.
        qc.invalidateQueries({ queryKey: ['podcast-chapters', episodeId] }),
        qc.invalidateQueries({ queryKey: transcriptQueryKey(episodeId) }),
      ])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not generate the summary.')
      throw err
    } finally {
      setGenerating(false)
    }
  }

  // Cheap to wire: the moment a transcript exists and nothing is cached, summarize.
  useEffect(() => {
    if (!transcriptReady || insights?.summary || generating) return
    if (autoTried.current === episodeId) return
    autoTried.current = episodeId
    void generate().catch(() => {})
  }, [transcriptReady, insights?.summary, episodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return null
  // No transcript, nothing to summarize from: the transcript panel owns that prompt.
  if (!transcriptReady && !insights?.summary) return null

  return (
    <Card className={cn('p-4', className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-bold">
          <Sparkles className="size-4 text-brand" /> Before you listen
        </h3>
        {insights?.summary && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => void generate(true).catch(() => {})}
            disabled={generating} title="Regenerate" aria-label="Regenerate summary"
            className="size-7 text-muted-foreground hover:text-foreground">
            {generating ? <Spinner className="text-current" /> : <RefreshCw className="size-3.5" />}
          </Button>
        )}
      </div>

      {generating && !insights?.summary ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Spinner /> Reading the transcript…
        </div>
      ) : insights?.summary ? (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">{insights.summary}</p>
          {insights.takeaways.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {insights.takeaways.map((t, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
                  <span className="text-muted-foreground">{t}</span>
                </li>
              ))}
            </ul>
          )}
          {insights.chaptersGenerated && (
            <p className="mt-3 text-xs text-muted-foreground/70">Chapters for this episode were generated from the transcript.</p>
          )}
        </>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Summarize this episode and pull out its key points, from the transcript.
          </p>
          <Button size="sm" onClick={() => void generate().catch(() => {})} disabled={generating}
            className="shrink-0 gap-1.5 font-semibold">
            {generating ? <Spinner className="text-current" /> : <Sparkles className="size-3.5" />} Generate
          </Button>
        </div>
      )}
    </Card>
  )
}
