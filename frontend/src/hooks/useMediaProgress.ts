import { useCallback, useEffect, useRef, useState } from 'react'

// Cross-device playback resume (#14). A player calls useMediaProgress(type, id), reads
// `resumeAt` once ready to seek there on load, and calls `report(position, duration)` from
// its timeupdate handler. Writes are throttled (~10s) and always flushed on pause/unmount, so
// a video/episode/song picked up on another device resumes at the same spot.

const FLUSH_INTERVAL_MS = 10_000

interface MediaProgressRow {
  positionSec: number
  durationSec: number | null
  completed: boolean
}

export function useMediaProgress(assetType: string | null | undefined, assetId: string | null | undefined) {
  const [resumeAt, setResumeAt] = useState<number | null>(null)
  const [ready, setReady] = useState(false)

  const pending = useRef<{ positionSec: number; durationSec: number | null; completed: boolean } | null>(null)
  const lastFlush = useRef(0)

  const key = assetType && assetId ? `${encodeURIComponent(assetType)}/${encodeURIComponent(assetId)}` : null

  // Load the saved position once per asset.
  useEffect(() => {
    setReady(false)
    setResumeAt(null)
    if (!key) return
    let cancelled = false
    fetch(`/api/media-progress/${key}`, { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<{ progress: MediaProgressRow | null }>) : null))
      .then((data) => {
        if (cancelled) return
        const p = data?.progress
        // Ignore a finished item or one within a few seconds of the start/end.
        if (p && !p.completed && p.positionSec > 5) setResumeAt(p.positionSec)
        setReady(true)
      })
      .catch(() => { if (!cancelled) setReady(true) })
    return () => { cancelled = true }
  }, [key])

  const flush = useCallback(() => {
    if (!key || !pending.current) return
    const body = JSON.stringify(pending.current)
    pending.current = null
    lastFlush.current = Date.now()
    // keepalive so an in-flight write survives a tab close / navigation.
    fetch(`/api/media-progress/${key}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  }, [key])

  const report = useCallback((positionSec: number, durationSec?: number | null, completed = false) => {
    if (!key || !Number.isFinite(positionSec)) return
    pending.current = { positionSec, durationSec: durationSec ?? null, completed }
    if (completed || Date.now() - lastFlush.current >= FLUSH_INTERVAL_MS) flush()
  }, [key, flush])

  // Flush any tail position on unmount (e.g. leaving the watch page).
  useEffect(() => () => { flush() }, [flush])

  return { resumeAt, ready, report, flush }
}
