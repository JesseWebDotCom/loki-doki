import { useState } from 'react'
import { Sparkles, Send } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { summarizeItem, askItem } from '@/lib/bookmarks/api'

// Reading-time AI for an offline article: TL;DR (+ auto-tags) and ask-the-article Q&A.
export function BookmarkAIPanel({ itemId }: { itemId: string }) {
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
    <Card className="mx-auto mt-6 max-w-[44rem] border-border/60 bg-card/50 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-primary" /> Ask AI about this article</div>

      {!summary ? (
        <Button variant="outline" size="sm" onClick={doSummarize} disabled={summarizing}>
          {summarizing ? <Spinner className="mr-1.5 text-current" /> : <Sparkles className="mr-1.5 size-4" />}Summarize (TL;DR)
        </Button>
      ) : (
        <p className="mb-3 rounded-control bg-background/60 p-3 text-sm leading-relaxed text-foreground/90">{summary}</p>
      )}

      <div className="mt-3 flex gap-2">
        <Input value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask a question about this article…"
          onKeyDown={e => { if (e.key === 'Enter') void doAsk() }} />
        <Button onClick={doAsk} disabled={asking || !question.trim()} size="icon">{asking ? <Spinner className="text-current" /> : <Send className="size-4" />}</Button>
      </div>
      {answer && <p className={cn('mt-3 rounded-control bg-background/60 p-3 text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap')}>{answer}</p>}
    </Card>
  )
}
