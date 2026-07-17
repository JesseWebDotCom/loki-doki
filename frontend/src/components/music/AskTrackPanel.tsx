import { memo, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { askTrack, type AskTrackMessage } from '@/lib/music/catalogApi'

/**
 * Ask-the-song: the Now Playing overlay's grounded Q&A tab, for music — the video watch
 * page's Ask-the-video, scoped to lyrics + artist/song background instead of a transcript.
 * Session-only: the thread lives in component state and is replayed to the backend, so
 * nothing is persisted. Streams token-by-token over SSE (lib/music/catalogApi.ts's
 * askTrack()), same contract as AskVideoPanel/AskEpisodePanel.
 */
export function AskTrackPanel({ artist, title, className }: { artist: string; title: string; className?: string }) {
  const [messages, setMessages] = useState<AskTrackMessage[]>([])
  const [question, setQuestion] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function ask() {
    const q = question.trim()
    if (!q || streaming) return
    setQuestion('')
    setError(null)
    const history = messages
    setMessages([...history, { role: 'user', content: q }, { role: 'assistant', content: '' }])
    setStreaming(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await askTrack(artist, title, q, history, (token) => {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + token }
          return next
        })
      }, ctrl.signal)
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not ask this song.')
        setMessages((prev) => prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev)
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {messages.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-white/60">
          Ask about this song — what it's about, who wrote it, why it matters. Answers draw
          on the lyrics and background, never leave your home server.
        </p>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
          {messages.map((m, i) => (
            <AskMessageRow key={i} message={m} pending={streaming && i === messages.length - 1 && m.content === ''} />
          ))}
        </div>
      )}

      {error && <p className="pb-2 text-xs text-red-300">{error}</p>}

      <div className="flex gap-2">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask() } }}
          placeholder="e.g. What's this song about?"
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

const AskMessageRow = memo(function AskMessageRow({ message, pending }: { message: AskTrackMessage; pending: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-card bg-white px-3 py-2 text-sm text-black">{message.content}</p>
      </div>
    )
  }
  return (
    <div className="flex">
      <div className="max-w-[92%] rounded-card bg-white/10 px-3 py-2 text-sm leading-relaxed text-white/90">
        {pending ? <Spinner size="sm" className="text-white/60" /> : message.content}
      </div>
    </div>
  )
})
