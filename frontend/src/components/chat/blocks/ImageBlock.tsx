import { useState, useEffect, useRef } from 'react'
import type { ImageGenBlockData } from './types'

type LiveState = 'building' | 'ready' | 'failed' | 'cancelled'

interface PollResponse {
  id: string
  state: LiveState
  stepCurrent?: number
  stepTotal?: number
  failureReason?: string
}

const POLL_MS = 2500

export function ImageBlock({ data }: { data: ImageGenBlockData }) {
  const [state, setState] = useState<LiveState>(data.status)
  const [stepCurrent, setStepCurrent] = useState(0)
  const [stepTotal, setStepTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const imageId = data.imageId

  useEffect(() => {
    if (state !== 'building') return

    async function poll() {
      try {
        const res = await fetch(`/api/image/artifacts/${imageId}`, { credentials: 'include' })
        if (res.ok && res.headers.get('Content-Type')?.startsWith('image/')) {
          setState('ready')
          return
        }
        if (res.status === 202 || res.ok) {
          const json = await res.json() as PollResponse
          if (json.state === 'ready') {
            setState('ready')
            return
          }
          if (json.state === 'failed' || json.state === 'cancelled') {
            setState(json.state)
            setError(json.failureReason ?? (json.state === 'cancelled' ? 'Cancelled' : 'Generation failed'))
            return
          }
          if (json.stepCurrent !== undefined) setStepCurrent(json.stepCurrent)
          if (json.stepTotal  !== undefined) setStepTotal(json.stepTotal)
        }
      } catch { /* network glitch — retry */ }

      timerRef.current = setTimeout(poll, POLL_MS)
    }

    timerRef.current = setTimeout(poll, POLL_MS)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [imageId, state])

  if (state === 'ready') {
    return (
      <div className="mt-2 max-w-sm">
        {!loaded && (
          <div className="aspect-square max-w-sm rounded-lg bg-muted animate-pulse" />
        )}
        <img
          src={`/api/image/artifacts/${imageId}`}
          alt={data.prompt}
          className={`rounded-lg max-w-full border border-border transition-opacity duration-500 ${loaded ? 'opacity-100' : 'opacity-0 absolute'}`}
          onLoad={() => setLoaded(true)}
        />
        {loaded && (
          <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{data.prompt}</p>
        )}
      </div>
    )
  }

  if (state === 'failed' || state === 'cancelled') {
    return (
      <div className="mt-2 flex items-center gap-2 text-sm text-destructive">
        <span className="opacity-60">{state === 'cancelled' ? 'Generation cancelled' : `Generation failed: ${error}`}</span>
      </div>
    )
  }

  // building — shimmer + progress
  const pct = stepTotal > 0 ? Math.round((stepCurrent / stepTotal) * 100) : 0

  return (
    <div className="mt-2 max-w-sm space-y-2">
      <div className="aspect-square max-w-sm rounded-lg overflow-hidden bg-muted relative">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-[shimmer_1.8s_linear_infinite] -translate-x-full" />
      </div>
      <div className="space-y-1">
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary transition-all duration-700"
            style={{ width: `${Math.max(4, pct)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {stepTotal > 0 ? `Step ${stepCurrent} / ${stepTotal}` : 'Starting generation…'}
        </p>
      </div>
    </div>
  )
}
