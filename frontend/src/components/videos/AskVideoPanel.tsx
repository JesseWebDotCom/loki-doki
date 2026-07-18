import { useRef, useState } from 'react'
import { CornerDownLeft, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ScrollFade } from '@/components/shared/ScrollFade'
import { cn } from '@/lib/cn'
import { askVideo, type VideoSource } from '@/lib/videos/api'

// Ask-the-video: the watch page's grounded Q&A tab. Answers come from the local model
// over this video's transcript; [t=123] citations render as tappable chips that seek the
// player to that moment. Kid-friendly by design (the model is told to explain simply).

interface Turn { role: 'user' | 'assistant'; content: string }

function fmtSeek(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** Render an answer, turning [t=123] citation tokens into seek chips. */
function AnswerText({ text, onSeek }: { text: string; onSeek: (sec: number) => void }) {
  const parts = text.split(/(\[t=\d+\])/g)
  return (
    <p className="whitespace-pre-wrap text-xs leading-relaxed">
      {parts.map((p, i) => {
        const m = p.match(/^\[t=(\d+)\]$/)
        if (!m) return <span key={i}>{p}</span>
        const sec = Number(m[1])
        return (
          <button key={i} onClick={() => onSeek(sec)}
            className="mx-0.5 inline-flex items-center rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand hover:bg-brand/25">
            {fmtSeek(sec)}
          </button>
        )
      })}
    </p>
  )
}

export function AskVideoPanel({ source, videoId, onSeek }: {
  source: VideoSource | 'youtube'
  videoId: string
  onSeek: (sec: number) => void
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  function scrollToEnd() {
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }))
  }

  async function send() {
    const question = input.trim()
    if (!question || busy) return
    setInput('')
    setBusy(true)
    const history = turns
    // The user turn plus the empty assistant turn tokens stream into.
    setTurns((t) => [...t, { role: 'user', content: question }, { role: 'assistant', content: '' }])
    scrollToEnd()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await askVideo(source, videoId, question, history, (token) => {
        setTurns((t) => {
          const next = [...t]
          const last = next[next.length - 1]
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + token }
          return next
        })
        scrollToEnd()
      }, ctrl.signal)
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const message = err instanceof Error ? err.message : 'I could not answer that right now.'
        setTurns((t) => {
          const next = [...t]
          const last = next[next.length - 1]
          // Replace the still-empty streamed turn rather than leave a blank bubble.
          if (last?.role === 'assistant' && last.content === '') next[next.length - 1] = { ...last, content: message }
          else next.push({ role: 'assistant', content: message })
          return next
        })
      }
    } finally {
      setBusy(false)
      abortRef.current = null
      scrollToEnd()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollFade fadeSize="h-8" className="min-h-0 flex-1">
        <div ref={scrollRef} className="space-y-3 pb-2">
          {turns.length === 0 && (
            <div className="px-1 py-6 text-center">
              <Sparkles className="mx-auto mb-2 size-5 text-brand" />
              <p className="text-xs text-muted-foreground">
                Ask anything about this video, what's shown, who's in it, why it's notable.
                Answers draw on the transcript, the channel's About text, and top comments,
                with tappable timestamps, and never leave your home server.
              </p>
            </div>
          )}
          {turns.map((t, i) => {
            const pending = busy && i === turns.length - 1 && t.role === 'assistant' && t.content === ''
            return (
              <div key={i} className={cn('max-w-[92%] rounded-card px-3 py-2',
                t.role === 'user' ? 'ml-auto bg-brand/15' : 'bg-foreground/5')}>
                {pending ? <Spinner className="size-3.5 text-muted-foreground" /> : t.role === 'assistant'
                  ? <AnswerText text={t.content} onSeek={onSeek} />
                  : <p className="text-xs leading-relaxed">{t.content}</p>}
              </div>
            )
          })}
        </div>
      </ScrollFade>
      <form className="mt-2 flex shrink-0 items-center gap-2" onSubmit={(e) => { e.preventDefault(); void send() }}>
        <Input value={input} onChange={(e) => setInput(e.target.value)}
          placeholder="Why did they…?" disabled={busy} className="h-9" />
        <Button type="submit" size="icon" disabled={busy || !input.trim()} aria-label="Ask" className="size-9 shrink-0">
          <CornerDownLeft className="size-4" />
        </Button>
      </form>
    </div>
  )
}
