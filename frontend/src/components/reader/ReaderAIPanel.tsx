import { useState } from 'react'
import { Sparkles, Loader2, Send } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { summarizeItem, askItem } from '@/lib/reader/api'

// Reading-time AI for an offline article: TL;DR (+ auto-tags) and ask-the-article Q&A.
export function ReaderAIPanel({ itemId }: { itemId: string }) {
  const [summary, setSummary] = useState<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  async function doSummarize() {
    setSummarizing(true)
    try { setSummary((await summarizeItem(itemId)).summary) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Summarize failed') }
    finally { setSummarizing(false) }
  }
  async function doAsk() {
    if (!question.trim()) return
    setAsking(true); setAnswer(null)
    try { setAnswer(await askItem(itemId, question.trim())) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Ask failed') }
    finally { setAsking(false) }
  }

  return (
    <div className="mx-auto mt-6 max-w-[44rem] rounded-2xl border border-border/60 bg-card/50 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-primary" /> Ask AI about this article</div>

      {!summary ? (
        <Button variant="outline" size="sm" onClick={doSummarize} disabled={summarizing}>
          {summarizing ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Sparkles className="mr-1.5 size-4" />}Summarize (TL;DR)
        </Button>
      ) : (
        <p className="mb-3 rounded-lg bg-background/60 p-3 text-sm leading-relaxed text-foreground/90">{summary}</p>
      )}

      <div className="mt-3 flex gap-2">
        <Input value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask a question about this article…"
          onKeyDown={e => { if (e.key === 'Enter') void doAsk() }} />
        <Button onClick={doAsk} disabled={asking || !question.trim()} size="icon">{asking ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button>
      </div>
      {answer && <p className={cn('mt-3 rounded-lg bg-background/60 p-3 text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap')}>{answer}</p>}
    </div>
  )
}
