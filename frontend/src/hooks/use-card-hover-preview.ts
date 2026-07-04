import { useEffect, useRef, useState } from 'react'
import { checkStreamPreview, fileUrl, proxyStreamUrl } from '@/lib/youtube/api'
import type { VideoItem } from '@/lib/youtube/types'

// Netflix's own card hover-preview only fires after a sustained hover, not an instant
// mouse-pass — this matches that feel while also giving a fast sweep across a grid time
// to move on before any work starts.
const HOVER_DEBOUNCE_MS = 550
// Defensive cap on simultaneous preview checks. Each one is at most a single InnerTube
// HTTP call server-side (no subprocess) — cheap, but this keeps a worst-case fast sweep
// from firing a burst of them all at once.
const MAX_IN_FLIGHT_CHECKS = 2
let inFlightChecks = 0

/** Debounced hover-preview for a `VideoCard`: after a sustained hover, plays a short
 *  muted clip over the static thumbnail — an offline file plays immediately, an online
 *  video asks the server for a preview stream (cache hit, or one bounded InnerTube call;
 *  never a yt-dlp resolve, since that would contend for the tiny global yt-dlp
 *  concurrency pool the real player also depends on). A video InnerTube won't cooperate
 *  with just silently keeps showing the static thumbnail instead. */
export function useCardHoverPreview(item: Pick<VideoItem, 'videoId' | 'localKind'>) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const clear = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    abortRef.current?.abort()
    abortRef.current = null
    setPreviewSrc(null)
  }

  const onMouseEnter = () => {
    timerRef.current = setTimeout(() => {
      if (item.localKind) { setPreviewSrc(fileUrl(item.videoId, item.localKind)); return }
      if (inFlightChecks >= MAX_IN_FLIGHT_CHECKS) return
      inFlightChecks++
      const ac = new AbortController()
      abortRef.current = ac
      checkStreamPreview(item.videoId, 'video', ac.signal)
        .then(available => { if (available && !ac.signal.aborted) setPreviewSrc(proxyStreamUrl(item.videoId, 'video')) })
        .finally(() => { inFlightChecks-- })
    }, HOVER_DEBOUNCE_MS)
  }

  const onMouseLeave = clear
  useEffect(() => clear, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { previewSrc, bind: { onMouseEnter, onMouseLeave } }
}
