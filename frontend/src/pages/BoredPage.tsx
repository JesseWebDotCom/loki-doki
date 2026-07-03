import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shuffle, ExternalLink } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { cardVariants } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useChatContext } from '@/context/ChatContext'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'

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

function CardInner({ a }: { a: Activity }) {
  const [imgOk, setImgOk] = useState(true)
  useEffect(() => { setImgOk(true) }, [a.image, a.zimIconUrl])
  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-muted/60 text-xl">
          {a.zimIconUrl && imgOk ? (
            <img src={a.zimIconUrl} alt="" className="size-6 object-contain" loading="lazy" onError={() => setImgOk(false)} />
          ) : a.image && imgOk ? (
            <img src={proxyImg(a.image)} alt="" className="size-6 object-contain" loading="lazy" onError={() => setImgOk(false)} />
          ) : (
            <span>{a.icon}</span>
          )}
        </div>
        <span className="text-overline text-brand">
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
  const interactive = cardVariants({ variant: 'interactive' })

  // Activities with a chat prompt kick off a conversation directly
  if (a.prompt) {
    return (
      <button onClick={() => onChatPrompt(a.prompt!)} className={cn(interactive, 'block w-full text-left')}>
        <CardInner a={a} />
      </button>
    )
  }
  if (a.href) {
    return <Link to={a.href} className={cn(interactive, 'block')}><CardInner a={a} /></Link>
  }
  if (a.url) {
    return <a href={a.url} target="_blank" rel="noopener noreferrer" className={cn(interactive, 'block')}><CardInner a={a} /></a>
  }
  // Real-world suggestion with no in-app action
  return <div className={cardVariants({ variant: 'surface' })}><CardInner a={a} /></div>
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
      <PageContainer className="pb-8">
        <PageHeader
          subtitle="Curated activity suggestions for any mood or energy level."
          actions={
            <Button variant="tinted" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner size="sm" className="text-brand" /> : <Shuffle className="size-3.5" />}
              Surprise me
            </Button>
          }
        />

        {error && (
          <div className="mb-4 rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && activities.length === 0 ? (
          <SkeletonCards count={6} className="sm:grid-cols-2 lg:grid-cols-3 grid-cols-1 gap-3" />
        ) : activities.length === 0 && !error ? (
          <div className="py-20 text-center text-sm text-muted-foreground">No suggestions right now. Try again.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activities.map((a) => <ActivityCard key={a.id} a={a} onChatPrompt={handleChatPrompt} />)}
          </div>
        )}
      </PageContainer>
    </PageShell>
  )
}
