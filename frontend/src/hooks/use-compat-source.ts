// Transcode fallback for a media element. Attach to any <video>/<audio> whose src can
// be a stored file in an arbitrary codec (studio uploads, local music, downloaded
// podcasts, saved videos). When the element throws a decode/format error, ask the
// item's compat endpoint; if the file genuinely can't play here, this hook drives the
// swap to a server-transcoded rendition:
//   desktop → the live ffmpeg pipe immediately (playback in seconds, no seeking),
//             then the cached seekable MP4 when the background encode lands;
//   iOS     → wait for the cached rendition (iOS can't play the non-seekable pipe),
//             surfacing progress so the UI can show "Making playable… 42%".
//
// The pattern mirrors the YouTube player's 202→poll→swap flow (VideoPlayer.tsx), but
// generalized behind one hook so every file-backed player behaves identically.

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchCompat, pollCompatReady, type CompatInfo } from '@/lib/compatPlayback'
import { isIOS } from '@/lib/platform'

export interface CompatSourceState {
  /** A compat rendition is (or is being) used instead of the original src. */
  active: boolean
  /** Waiting on the cached rendition (iOS, or desktop before the live pipe swap). */
  preparing: boolean
  progressPct: number | null
  /** Transcode failed - the original error stands. */
  failed: string | null
}

const IDLE: CompatSourceState = { active: false, preparing: false, progressPct: null, failed: null }

export function useCompatSource(
  mediaRef: React.RefObject<HTMLMediaElement | null>,
  /** The item's compat endpoint, or null when the current src has no compat coverage. */
  compatUrl: string | null,
): CompatSourceState {
  const [state, setState] = useState<CompatSourceState>(IDLE)
  const startedRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  // Live-pipe playback starts the element clock at 0 regardless of real position; track
  // the offset so the swap to the seekable rendition restores the true position.
  const liveOffsetRef = useRef(0)

  // New item → forget everything about the previous one.
  useEffect(() => {
    startedRef.current = false
    liveOffsetRef.current = 0
    abortRef.current?.abort()
    abortRef.current = null
    setState(IDLE)
  }, [compatUrl])

  const begin = useCallback(async () => {
    const el = mediaRef.current
    if (!el || !compatUrl || startedRef.current) return
    startedRef.current = true
    const ctrl = new AbortController()
    abortRef.current = ctrl

    const resumeAt = el.currentTime > 0 ? el.currentTime : 0
    const info: CompatInfo | null = await fetchCompat(compatUrl)
    if (ctrl.signal.aborted) return
    if (!info || info.compatible || !info.id) {
      // Compatible file (or unknown) means the element error had some other cause -
      // nothing a transcode would fix; leave the player's own error handling to it.
      startedRef.current = false
      return
    }
    if (info.status === 'failed') {
      setState({ active: false, preparing: false, progressPct: null, failed: info.error ?? 'Transcode failed' })
      return
    }

    const swapTo = (src: string, at: number, seekable: boolean) => {
      const wasPaused = el.paused && el.currentTime > 0
      if (!seekable) liveOffsetRef.current = at
      el.src = seekable ? src : `${src}${src.includes('?') ? '&' : '?'}t=${Math.floor(at)}`
      el.load()
      if (seekable && at > 0) {
        const onMeta = () => { el.currentTime = at }
        el.addEventListener('loadedmetadata', onMeta, { once: true })
      }
      if (!wasPaused) void el.play().catch(() => {})
    }

    const ready = info.status === 'ready'
    if (ready && info.streamUrl) {
      setState({ active: true, preparing: false, progressPct: 100, failed: null })
      swapTo(info.streamUrl, resumeAt, true)
      return
    }

    // Not ready yet: desktop bridges on the live pipe; iOS shows progress and waits.
    const useLive = !!info.liveUrl && !isIOS()
    setState({ active: useLive, preparing: true, progressPct: info.progressPct ?? 0, failed: null })
    if (useLive && info.liveUrl) swapTo(info.liveUrl, resumeAt, false)

    const outcome = await pollCompatReady(info.id, {
      signal: ctrl.signal,
      onProgress: (pct) => setState((s) => ({ ...s, progressPct: pct })),
    })
    if (ctrl.signal.aborted) return
    if (outcome === 'failed') {
      setState((s) => ({ ...s, preparing: false, failed: 'Could not convert this file for playback' }))
      return
    }
    const at = useLive ? liveOffsetRef.current + el.currentTime : resumeAt
    setState({ active: true, preparing: false, progressPct: 100, failed: null })
    if (info.streamUrl) swapTo(info.streamUrl, at, true)
  }, [mediaRef, compatUrl])

  useEffect(() => {
    if (!compatUrl) return
    // Document-level capture ('error' doesn't bubble, but is capturable) so this works
    // even when the media element mounts after this effect ran.
    const onError = (e: Event) => { if (e.target === mediaRef.current && mediaRef.current) void begin() }
    document.addEventListener('error', onError, true)
    return () => {
      document.removeEventListener('error', onError, true)
      abortRef.current?.abort()
    }
  }, [mediaRef, compatUrl, begin])

  return state
}
