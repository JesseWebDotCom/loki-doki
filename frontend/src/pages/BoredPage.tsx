import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shuffle, ExternalLink, Loader2 } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useChatContext } from '@/context/ChatContext'
import { cn } from '@/lib/cn'

type ActivityCategory = 'article' | 'recipe' | 'joke' | 'idea' | 'create'

interface Activity {
  id: string
  category: ActivityCategory
  title: string
  description: string
  icon: string
  href?: string
  prompt?: string
  url?: string
  image?: string
  zimIconUrl?: string
  zimCategory?: string
}

const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  article: 'Learn', recipe: 'Cook', joke: 'Laugh', idea: 'Do', create: 'Create',
}

const CATEGORY_ACCENT: Record<ActivityCategory, string> = {
  article: 'text-sky-400',
  recipe:  'text-orange-400',
  joke:    'text-amber-400',
  idea:    'text-emerald-400',
  create:  'text-violet-400',
}

function CardInner({ a }: { a: Activity }) {
  const [imgOk, setImgOk] = useState(true)
  useEffect(() => { setImgOk(true) }, [a.image, a.zimIconUrl])
  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-xl">
          {a.zimIconUrl && imgOk ? (
            <img src={a.zimIconUrl} alt="" className="size-6 object-contain" loading="lazy" onError={() => setImgOk(false)} />
          ) : a.image && imgOk ? (
            <img src={a.image} alt="" className="size-6 object-contain" loading="lazy" onError={() => setImgOk(false)} />
          ) : (
            <span>{a.icon}</span>
          )}
        </div>
        <span className={cn('text-[10px] font-semibold uppercase tracking-wider', CATEGORY_ACCENT[a.category])}>
          {CATEGORY_LABEL[a.category]}
        </span>
      </div>
      <div className="mt-1 min-w-0">
        <p className="text-sm font-semibold leading-snug">{a.title}</p>
        <p className={cn('mt-1 text-xs text-muted-foreground', a.category === 'joke' ? '' : 'line-clamp-3')}>
          {a.description}
        </p>
      </div>
      {a.url && (
        <span className="mt-auto inline-flex items-center gap-1 pt-1 text-[11px] font-medium text-muted-foreground">
          Open <ExternalLink className="size-3" />
        </span>
      )}
    </div>
  )
}

function ActivityCard({ a, onChatPrompt }: { a: Activity; onChatPrompt: (prompt: string) => void }) {
  const navigate = useNavigate()
  const base = 'group rounded-2xl border border-border/60 bg-card transition-all hover:border-brand/40 hover:shadow-md active:scale-[0.99]'

  // Activities with a chat prompt kick off a conversation directly
  if (a.prompt) {
    return (
      <button onClick={() => onChatPrompt(a.prompt!)} className={cn(base, 'block w-full text-left cursor-pointer')}>
        <CardInner a={a} />
      </button>
    )
  }
  if (a.href) {
    return <Link to={a.href} className={cn(base, 'block')}><CardInner a={a} /></Link>
  }
  if (a.url) {
    return <a href={a.url} target="_blank" rel="noopener noreferrer" className={cn(base, 'block')}><CardInner a={a} /></a>
  }
  // Real-world suggestion — no in-app action
  return <div className={base}><CardInner a={a} /></div>
}

export function BoredPage() {
  const [activities, setActivities] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const { queuePrompt } = useChatContext()

  usePublishUIContext({
    label: "I'm Bored",
    description: 'Browsing activity suggestions on the I\'m Bored page.',
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/bored/suggestions', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load suggestions')
      const data = (await res.json()) as { activities: Activity[] }
      setActivities(data.activities ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleChatPrompt = useCallback((prompt: string) => {
    queuePrompt(prompt)
    navigate('/chat')
  }, [queuePrompt, navigate])

  return (
    <PageShell>
      {/* Title row */}
      <div className="flex items-center justify-between px-5 pt-5 pb-2 shrink-0">
        <div>
          <h1 className="text-xl font-black tracking-tight">I'm Bored</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Curated activity suggestions for any mood or energy level.</p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-xl bg-foreground/8 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-foreground/12 active:scale-95 disabled:opacity-50"
        >
          <Shuffle className={cn('size-3.5', loading && 'animate-spin')} />
          Surprise me
        </button>
      </div>

      {/* Content */}
      <div className="px-4 pb-5 sm:px-6">
        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && activities.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : activities.length === 0 && !error ? (
          <div className="py-20 text-center text-sm text-muted-foreground">No suggestions right now — try again.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activities.map((a) => <ActivityCard key={a.id} a={a} onChatPrompt={handleChatPrompt} />)}
          </div>
        )}
      </div>
    </PageShell>
  )
}
