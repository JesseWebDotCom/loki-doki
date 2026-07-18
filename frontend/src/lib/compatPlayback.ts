// Client for the on-demand transcode endpoints (backend lib/mediacompat).
//
// Flow: a media route exposes a per-item `.../compat` endpoint. Asking it either says
// "the original plays everywhere" or returns a transcode-entry descriptor whose job the
// ask itself just queued. The player then polls /api/compat/status/:id until the cached
// rendition is ready (streamUrl), optionally playing the non-seekable liveUrl meanwhile.

export interface CompatInfo {
  compatible: boolean
  kind?: 'video' | 'audio' | 'image'
  remote?: boolean
  id?: string
  status?: 'pending' | 'running' | 'ready' | 'failed'
  progressPct?: number | null
  error?: string | null
  reasons?: string[]
  streamUrl?: string
  liveUrl?: string
}

export async function fetchCompat(compatUrl: string): Promise<CompatInfo | null> {
  try {
    const res = await fetch(compatUrl, { credentials: 'include' })
    if (!res.ok) return null
    return (await res.json()) as CompatInfo
  } catch {
    return null
  }
}

/** Poll a transcode entry until it settles. Resolves 'ready' | 'failed' ('failed' also
 *  covers an entry that vanished). Respects the signal between polls. */
export async function pollCompatReady(
  id: string,
  opts: { signal?: AbortSignal; onProgress?: (pct: number | null) => void; intervalMs?: number } = {},
): Promise<'ready' | 'failed'> {
  const interval = opts.intervalMs ?? 3000
  for (;;) {
    if (opts.signal?.aborted) return 'failed'
    try {
      const res = await fetch(`/api/compat/status/${id}`, { credentials: 'include', signal: opts.signal })
      if (res.ok) {
        const s = (await res.json()) as { status: string; progressPct: number | null }
        if (s.status === 'ready') return 'ready'
        if (s.status === 'failed') return 'failed'
        opts.onProgress?.(s.progressPct)
      } else if (res.status === 404) {
        return 'failed'
      }
    } catch (e) {
      if (opts.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return 'failed'
      // transient network error - keep polling
    }
    await new Promise<void>((r) => {
      const t = setTimeout(r, interval)
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
    })
  }
}

/** One-call helper for background-audio: resolve a playable audio-only URL for an item
 *  (queuing the extraction if needed), or null if not (yet) available. Non-blocking by
 *  design - callers prewarm early and just get null until the rendition lands. */
export async function resolveCompatAudioUrl(compatUrl: string): Promise<string | null> {
  const info = await fetchCompat(compatUrl)
  if (!info) return null
  if (info.compatible) return null   // caller should use its normal audio URL if it has one
  if (info.status === 'ready' && info.streamUrl) return info.streamUrl
  return null
}
