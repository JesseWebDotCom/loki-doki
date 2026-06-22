import { useEffect, useState } from 'react'
import { Loader2, Quote, RefreshCw, Smile } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { cn } from '@/lib/cn'

interface JokeResponse {
  joke: string | null
  error?: string
}

export function JokePage() {
  const [joke, setJoke] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [refreshing, setRefreshing] = useState(false)

  usePublishUIContext({
    label: 'Joke of the Day',
    description: 'User is reading the Joke of the Day.',
  })

  useEffect(() => {
    fetch('/api/jokes', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: JokeResponse) => {
        setJoke(d.joke ?? null)
        setStatus(d.joke ? 'ready' : 'error')
      })
      .catch(() => setStatus('error'))
  }, [])

  async function handleFresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const r = await fetch('/api/jokes/fresh', { credentials: 'include' })
      const d = (await r.json()) as JokeResponse
      setJoke(d.joke ?? null)
      setStatus(d.joke ? 'ready' : 'error')
    } catch {
      setStatus('error')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <PageShell gradient="linear-gradient(135deg,#78350f,#d97706)" GhostIcon={Smile}>
      <PageHeader
        variant="compact"
        eyebrow="Entertainment"
        title="Joke of the Day"
        gradient="linear-gradient(135deg,#78350f,#d97706)"
        icon={<Smile className="size-7 text-white" />}
      />

      <div className="flex flex-1 items-center justify-center px-5 pb-10">
        {status === 'loading' && (
          <div className="w-full max-w-lg animate-pulse rounded-3xl border border-border/40 bg-card p-8">
            <div className="mb-5 h-8 w-8 rounded-lg bg-muted/60" />
            <div className="space-y-3">
              <div className="h-5 rounded-full bg-muted/60" />
              <div className="h-5 w-5/6 rounded-full bg-muted/60" />
              <div className="h-5 w-2/3 rounded-full bg-muted/60" />
            </div>
            <div className="mt-8 h-9 w-36 rounded-xl bg-muted/60" />
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 text-center">
            <Smile className="size-12 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No jokes today.</p>
            <button
              onClick={() => void handleFresh()}
              disabled={refreshing}
              className="mt-2 inline-flex items-center gap-2 rounded-xl bg-foreground/8 px-4 py-2 text-sm font-semibold transition-colors hover:bg-foreground/12 active:scale-95 disabled:opacity-50"
            >
              {refreshing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Try again
            </button>
          </div>
        )}

        {status === 'ready' && joke && (
          <div className="w-full max-w-lg rounded-3xl border border-border/40 bg-card p-8 shadow-lg">
            <Quote className="mb-4 size-8 text-amber-500/60" />
            <p className={cn('text-xl font-medium leading-relaxed')}>{joke}</p>
            <div className="mt-8">
              <button
                onClick={() => void handleFresh()}
                disabled={refreshing}
                className="inline-flex items-center gap-2 rounded-xl bg-amber-500/15 px-4 py-2.5 text-sm font-semibold text-amber-600 transition-colors hover:bg-amber-500/25 active:scale-95 disabled:opacity-50 dark:text-amber-400"
              >
                {refreshing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Tell me another
              </button>
            </div>
          </div>
        )}
      </div>
    </PageShell>
  )
}
