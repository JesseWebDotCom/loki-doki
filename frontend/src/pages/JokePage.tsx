import { useEffect, useState } from 'react'
import { Quote, RefreshCw, Smile } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { usePublishUIContext } from '@/context/UIContextProvider'

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
    <PageShell>
      <PageContainer className="flex flex-1 flex-col">
        <PageHeader subtitle="A new punchline delivered fresh every day." />

        <div className="flex flex-1 items-center justify-center pb-10">
          {status === 'loading' && (
            <Card className="w-full max-w-lg p-8">
              <Skeleton className="mb-5 size-8" />
              <div className="space-y-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-5/6" />
                <Skeleton className="h-5 w-2/3" />
              </div>
              <Skeleton className="mt-8 h-9 w-36 rounded-full" />
            </Card>
          )}

          {status === 'error' && (
            <div className="flex flex-col items-center gap-3 text-center">
              <Smile className="size-12 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No jokes today.</p>
              <Button
                variant="tinted"
                className="mt-2"
                onClick={() => void handleFresh()}
                disabled={refreshing}
              >
                {refreshing ? (
                  <Spinner className="text-brand" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Try again
              </Button>
            </div>
          )}

          {status === 'ready' && joke && (
            <Card className="w-full max-w-lg p-8">
              <Quote className="mb-4 size-8 text-brand/60" />
              <p className="text-xl font-medium leading-relaxed">{joke}</p>
              <div className="mt-8">
                <Button
                  variant="tinted"
                  onClick={() => void handleFresh()}
                  disabled={refreshing}
                >
                  {refreshing ? (
                    <Spinner className="text-brand" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  Tell me another
                </Button>
              </div>
            </Card>
          )}
        </div>
      </PageContainer>
    </PageShell>
  )
}
