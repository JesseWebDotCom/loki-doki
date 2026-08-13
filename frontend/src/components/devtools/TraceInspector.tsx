import { useEffect, useState } from 'react'
import { ChevronLeft, RefreshCw, ThumbsDown, ThumbsUp } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { formatRelativeTime } from '@/lib/relativeTime'

// Per-turn chat traces (admin devtools): what the model actually saw and did on
// recent assistant replies — route decision, tool trail, real token counts, and
// the full assembled system prompt. Backed by /api/admin/traces (newest 500).

interface TraceRow {
  id: string
  messageId: string
  conversationId: string
  userId: string
  route: { path?: string; toolId: string | null; extraToolIds?: string[] } | null
  toolTrail: Array<{ toolId: string; ok: boolean; ms: number; error?: string }> | null
  model: string | null
  promptTokens: number | null
  genTokens: number | null
  durationMs: number | null
  firstTokenMs: number | null
  createdAt: number
}

interface TraceDetail extends TraceRow {
  systemPrompt: string | null
  reply: { content: string; feedback: 'up' | 'down' | null; feedbackNote: string | null; truncated: boolean } | null
}

export function TraceInspector() {
  const [rows, setRows] = useState<TraceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<TraceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  async function refresh() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/traces?limit=100', { credentials: 'include' })
      if (res.ok) setRows(await res.json())
    } catch { /* offline */ }
    setLoading(false)
  }

  useEffect(() => { void refresh() }, [])

  async function openTrace(id: string) {
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/admin/traces/${id}`, { credentials: 'include' })
      if (res.ok) setDetail(await res.json())
    } catch { /* offline */ }
    setDetailLoading(false)
  }

  if (detail || detailLoading) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setDetail(null)} className="text-muted-foreground">
          <ChevronLeft className="size-3.5" />
          All traces
        </Button>
        {detailLoading || !detail ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <TraceDetailView trace={detail} />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          The newest {rows.length} chat turns, most recent first. Temporary chats are never traced.
        </p>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} className="text-muted-foreground">
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground/50">No traces yet. Send a chat message and refresh.</p>
      ) : (
        <div className="overflow-hidden rounded-card border border-border">
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => void openTrace(r.id)}
              className="flex w-full items-center gap-3 border-b border-border/40 px-3 py-2 text-left text-xs transition-colors last:border-0 hover:bg-foreground/[0.03]"
            >
              <span className="w-20 shrink-0 text-muted-foreground/60">{formatRelativeTime(new Date(r.createdAt * 1000))}</span>
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                {r.route?.toolId ?? r.route?.path ?? 'chat'}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {r.model ?? '?'}
              </span>
              <span className="hidden shrink-0 tabular-nums text-muted-foreground/70 sm:inline">
                {r.promptTokens ?? '?'}→{r.genTokens ?? '?'} tok
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground/70">
                {r.firstTokenMs != null ? `${(r.firstTokenMs / 1000).toFixed(1)}s ttft` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TraceDetailView({ trace }: { trace: TraceDetail }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">{trace.model ?? 'unknown model'}</Badge>
        <Badge variant="secondary" className="font-mono text-[10px]">{trace.route?.path ?? 'no route info'}</Badge>
        {trace.route?.toolId && <Badge variant="info" className="font-mono text-[10px]">{trace.route.toolId}</Badge>}
        {trace.reply?.truncated && <Badge variant="destructive" className="text-[10px]">truncated</Badge>}
        {trace.reply?.feedback === 'up' && <ThumbsUp className="size-3.5 text-success" />}
        {trace.reply?.feedback === 'down' && <ThumbsDown className="size-3.5 text-destructive" />}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <Stat label="Prompt tokens" value={trace.promptTokens} />
        <Stat label="Generated" value={trace.genTokens} />
        <Stat label="First token" value={trace.firstTokenMs != null ? `${trace.firstTokenMs} ms` : null} />
        <Stat label="Total" value={trace.durationMs != null ? `${trace.durationMs} ms` : null} />
      </dl>

      {trace.toolTrail && trace.toolTrail.length > 0 && (
        <section>
          <h3 className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">Tool trail</h3>
          <div className="overflow-hidden rounded-card border border-border">
            {trace.toolTrail.map((t, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border/40 px-3 py-1.5 text-xs last:border-0">
                <span className={cn('size-1.5 shrink-0 rounded-full', t.ok ? 'bg-success' : 'bg-destructive')} />
                <span className="font-mono">{t.toolId}</span>
                <span className="tabular-nums text-muted-foreground/70">{t.ms} ms</span>
                {t.error && <span className="min-w-0 flex-1 truncate text-destructive">{t.error}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {trace.reply?.feedbackNote && (
        <section>
          <h3 className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">Feedback note</h3>
          <p className="rounded-card border border-border bg-card px-3 py-2 text-xs">{trace.reply.feedbackNote}</p>
        </section>
      )}

      {trace.reply && (
        <section>
          <h3 className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">Reply</h3>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-card border border-border bg-card px-3 py-2 font-mono text-[11px] leading-relaxed">{trace.reply.content}</pre>
        </section>
      )}

      <section>
        <h3 className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">Assembled system prompt</h3>
        <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-card border border-border bg-card px-3 py-2 font-mono text-[11px] leading-relaxed">{trace.systemPrompt ?? '(not captured)'}</pre>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number | null }) {
  return (
    <>
      <dt className="text-muted-foreground/60">{label}</dt>
      <dd className="tabular-nums">{value ?? '-'}</dd>
    </>
  )
}
