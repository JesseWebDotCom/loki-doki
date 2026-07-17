import { memo, useMemo, useRef, useState } from 'react'
import { MessagesSquare, Send } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { askEpisode, type AskMessage } from '@/lib/podcast/aiApi'
import { fmtTime } from '@/lib/podcast/format'

/** [H:MM:SS] / [MM:SS] stamps the model cites, so an answer can jump you there. */
const STAMP_RE = /\[(\d{1,2}:)?\d{1,2}:\d{2}\]/g

function stampToSeconds(stamp: string): number {
  const parts = stamp.replace(/[[\]]/g, '').split(':').map(Number)
  return parts.reduce((acc, p) => acc * 60 + (Number.isFinite(p) ? p : 0), 0)
}

/**
 * A lightweight per-episode chat grounded in the transcript. Session-only by design:
 * the thread lives in component state and is replayed to the backend, so nothing is
 * persisted. Long transcripts get relevant chunks retrieved server-side first.
 */
export function AskEpisodePanel({ episodeId, transcriptReady, onSeek, className }: {
  episodeId: string
  transcriptReady: boolean
  onSeek?: (sec: number) => void
  className?: string
}) {
  const [messages, setMessages] = useState<AskMessage[]>([])
  const [question, setQuestion] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function ask() {
    const q = question.trim()
    if (!q || streaming) return
    setQuestion('')
    setError(null)
    // The user turn plus the empty assistant turn the tokens stream into.
    const history = messages
    setMessages([...history, { role: 'user', content: q }, { role: 'assistant', content: '' }])
    setStreaming(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await askEpisode(episodeId, q, history, token => {
        // Replace the whole array per token (the app's streaming contract); the row
        // component is memoized so this stays linear rather than O(n squared).
        setMessages(prev => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + token }
          return next
        })
      }, ctrl.signal)
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not ask this episode.')
        // Drop the empty assistant turn rather than leave a blank bubble.
        setMessages(prev => prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev)
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  if (!transcriptReady) {
    return (
      <div className={cn('flex flex-col items-center gap-2 px-4 py-8 text-center', className)}>
        <div className="flex size-12 items-center justify-center rounded-card bg-muted/50">
          <MessagesSquare className="size-6 opacity-40" />
        </div>
        <p className="text-sm font-medium">Ask this episode anything</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Once this episode has a transcript, you can ask what it covered and jump straight to the answer.
        </p>
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {messages.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground/60">
          Ask what this episode said about anything. Answers come only from the transcript.
        </p>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
          {messages.map((m, i) => (
            <AskMessageRow key={i} message={m} onSeek={onSeek}
              pending={streaming && i === messages.length - 1 && m.content === ''} />
          ))}
        </div>
      )}

      {error && <p className="pb-2 text-xs text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask() } }}
          placeholder="e.g. What did they say about sleep?"
          disabled={streaming}
          className="h-9"
        />
        <Button type="button" size="icon" onClick={() => void ask()} disabled={streaming || !question.trim()}
          aria-label="Ask" className="size-9 shrink-0">
          {streaming ? <Spinner className="text-current" /> : <Send className="size-4" />}
        </Button>
      </div>
    </div>
  )
}

/** One turn. Memoized: the parent replaces the messages array on every streamed token,
 *  so without this every earlier turn would re-render per token (the O(n squared) trap
 *  the streaming render contract exists to prevent). */
const AskMessageRow = memo(function AskMessageRow({ message, pending, onSeek }: {
  message: AskMessage
  pending: boolean
  onSeek?: (sec: number) => void
}) {
  // Timestamps become seek buttons. Memoized for the same reason as the row itself.
  const parts = useMemo(() => {
    if (message.role !== 'assistant' || !onSeek) return null
    const out: Array<{ text: string; stamp: boolean }> = []
    let last = 0
    for (const m of message.content.matchAll(STAMP_RE)) {
      const at = m.index ?? 0
      if (at > last) out.push({ text: message.content.slice(last, at), stamp: false })
      out.push({ text: m[0], stamp: true })
      last = at + m[0].length
    }
    if (last < message.content.length) out.push({ text: message.content.slice(last), stamp: false })
    return out
  }, [message.content, message.role, onSeek])

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-card bg-brand px-3 py-2 text-sm text-brand-foreground">{message.content}</p>
      </div>
    )
  }

  return (
    <div className="flex">
      <div className="max-w-[92%] rounded-card bg-muted/60 px-3 py-2 text-sm leading-relaxed text-foreground">
        {pending ? <Spinner size="sm" className="text-muted-foreground" /> : parts ? parts.map((p, i) =>
          p.stamp ? (
            <button key={i} onClick={() => onSeek?.(stampToSeconds(p.text))}
              className="font-semibold tabular-nums text-brand hover:underline"
              title={`Jump to ${fmtTime(stampToSeconds(p.text))}`}>
              {p.text}
            </button>
          ) : <span key={i}>{p.text}</span>,
        ) : message.content}
      </div>
    </div>
  )
})
