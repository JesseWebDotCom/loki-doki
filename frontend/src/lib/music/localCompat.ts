// Compat overrides for local-library tracks. Scanned folders hold whatever the user
// ripped - ALAC, opus, vorbis, APE - which not every browser decodes. When a deck
// errors on a local ref, resolveLocalCompat asks the collection's compat endpoint
// (which queues an on-demand AAC rendition) and remembers the rendition URL, so the
// engine can re-cue now (when the encode is quick) and cue correctly forever after.

import { parseTrackRef } from '@/lib/music/trackRef'
import { fetchCompat, pollCompatReady } from '@/lib/compatPlayback'

const overrides = new Map<string, string>()   // ref → transcoded stream URL
const inFlight = new Map<string, Promise<string | null>>()

/** Known-good rendition URL for a local ref, if one was already resolved this session. */
export function localCompatOverride(ref: string): string | null {
  return overrides.get(ref) ?? null
}

/** Resolve (and if needed, wait for) a browser-safe rendition of a local track.
 *  Returns null for non-local refs, files that are already compatible (the error had
 *  another cause), or a failed transcode. */
export function resolveLocalCompat(ref: string): Promise<string | null> {
  const hit = inFlight.get(ref)
  if (hit) return hit
  const p = (async () => {
    const parsed = parseTrackRef(ref)
    if (parsed.source !== 'local') return null
    const info = await fetchCompat(`/api/music/collection/local/compat/${encodeURIComponent(parsed.localId)}`)
    if (!info || info.compatible || !info.id || !info.streamUrl) return null
    if (info.status !== 'ready') {
      const outcome = await pollCompatReady(info.id)
      if (outcome !== 'ready') return null
    }
    overrides.set(ref, info.streamUrl)
    return info.streamUrl
  })()
  inFlight.set(ref, p)
  p.catch(() => {}).finally(() => { if (!overrides.has(ref)) inFlight.delete(ref) })
  return p
}
