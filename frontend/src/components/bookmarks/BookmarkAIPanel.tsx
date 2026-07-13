import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Sparkles, Send, Tag, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { summarizeItem, askItem, autoTagItem, type AutoTagMode } from '@/lib/bookmarks/api'

const TAG_MODES: { mode: AutoTagMode; label: string; hint: string }[] = [
  { mode: 'generate', label: 'Generate new tags', hint: 'Invent fresh topic tags from the content' },
  { mode: 'existing', label: 'From my existing tags', hint: 'Pick only tags I already use' },
]

// Reading-time AI for an offline article: TL;DR (+ auto-tags) and ask-the-article Q&A.
export function BookmarkAIPanel({ itemId }: { itemId: string }) {
  const qc = useQueryClient()
  const [summary, setSummary] = useState<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [tagging, setTagging] = useState(false)
  const [newTags, setNewTags] = useState<string[] | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  async function doSummarize() {
    setSummarizing(true)
    try { setSummary((await summarizeItem(itemId)).summary) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Summarize failed') }
    finally { setSummarizing(false) }
  }
  async function doAutoTag(mode: AutoTagMode) {
    setTagging(true); setNewTags(null)
    try {
      const tags = await autoTagItem(itemId, mode)
      setNewTags(tags)
      if (tags.length) { toast.success(`Tagged: ${tags.join(', ')}`); qc.invalidateQueries({ queryKey: ['bookmark-tags'] }); qc.invalidateQueries({ queryKey: ['bookmarks'] }) }
      else toast.info('No matching tags found')
    }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Auto-tag failed') }
    finally { setTagging(false) }
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

      <div className="flex flex-wrap items-center gap-2">
        {!summary ? (
          <Button variant="outline" size="sm" onClick={doSummarize} disabled={summarizing}>
            {summarizing ? <Spinner className="mr-1.5 text-current" /> : <Sparkles className="mr-1.5 size-4" />}Summarize (TL;DR)
          </Button>
        ) : (
          <p className="w-full rounded-control bg-background/60 p-3 text-sm leading-relaxed text-foreground/90">{summary}</p>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={tagging}>
              {tagging ? <Spinner className="mr-1.5 text-current" /> : <Tag className="mr-1.5 size-4" />}Auto-tag<ChevronDown className="ml-1 size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>Auto-tag with AI</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {TAG_MODES.map(m => (
              <DropdownMenuItem key={m.mode} onClick={() => doAutoTag(m.mode)} className="flex-col items-start gap-0.5">
                <span className="text-sm">{m.label}</span>
                <span className="text-xs text-muted-foreground">{m.hint}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {newTags && newTags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {newTags.map(t => <span key={t} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"><Tag className="mr-1 inline size-3" />{t}</span>)}
        </div>
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
