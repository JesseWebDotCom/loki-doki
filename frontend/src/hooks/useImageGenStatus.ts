import { useState, useEffect, useRef } from 'react'

export type ImageGenState = 'idle' | 'warming' | 'ready' | 'failed' | 'unknown'

interface StatusResponse {
  ok: boolean
  warming: boolean
  state: ImageGenState
}

const POLL_INTERVAL_MS = 6_000

export function useImageGenStatus() {
  const [status, setStatus] = useState<ImageGenState>('unknown')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true

    async function poll() {
      try {
        const res = await fetch('/api/image/status', { credentials: 'include' })
        if (!alive) return
        if (res.ok) {
          const data = await res.json() as StatusResponse
          const next: ImageGenState = data.ok ? 'ready' : data.warming ? 'warming' : (data.state ?? 'failed')
          setStatus(next)
          // Stop polling once ready or permanently failed
          if (next === 'ready' || next === 'failed' || next === 'idle') return
        }
      } catch {
        if (!alive) return
      }
      if (alive) timerRef.current = setTimeout(poll, POLL_INTERVAL_MS)
    }

    poll()
    return () => {
      alive = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return status
}
