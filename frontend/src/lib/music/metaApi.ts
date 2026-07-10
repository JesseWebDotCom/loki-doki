import { useEffect, useState } from 'react'
// Client for /api/music/meta - audio facts (codec/bitrate/LUFS), waveform peaks, and
// per-user star ratings, all keyed by unified track ref.

export interface TrackAudioFacts {
  ref: string
  codec: string | null
  bitrateKbps: number | null
  sampleRate: number | null
  bitDepth?: number | null
  channels: number | null
  durationSec: number | null
  lufs: number | null
  truePeakDb: number | null
}

const factsCache = new Map<string, TrackAudioFacts | null>()
const peaksCache = new Map<string, number[] | null>()

export async function getAudioFacts(ref: string): Promise<TrackAudioFacts | null> {
  if (factsCache.has(ref)) return factsCache.get(ref) ?? null
  try {
    const r = await fetch(`/api/music/meta/audio?refs=${encodeURIComponent(ref)}`, { credentials: 'include' })
    const body = await r.json() as Record<string, TrackAudioFacts>
    const facts = body[ref] ?? null
    factsCache.set(ref, facts)
    return facts
  } catch {
    return null
  }
}

/** Waveform envelope (0..255 per bucket), or null when unscanned. A miss lazily queues a
 *  server-side scan, so the bar appears the next time the track plays. */
export async function getWaveform(ref: string): Promise<number[] | null> {
  if (peaksCache.has(ref)) return peaksCache.get(ref) ?? null
  try {
    const r = await fetch(`/api/music/meta/waveform/${encodeURIComponent(ref)}`, { credentials: 'include' })
    if (!r.ok) { peaksCache.set(ref, null); return null }
    const body = await r.json() as { peaks?: number[] }
    const peaks = body.peaks?.length ? body.peaks : null
    peaksCache.set(ref, peaks)
    return peaks
  } catch {
    return null
  }
}

export async function getRatings(refs: string[]): Promise<Record<string, number>> {
  if (!refs.length) return {}
  try {
    const r = await fetch(`/api/music/meta/ratings?refs=${encodeURIComponent(refs.join(','))}`, { credentials: 'include' })
    return await r.json() as Record<string, number>
  } catch {
    return {}
  }
}

export async function setRating(ref: string, stars: number, title?: string, artist?: string | null): Promise<void> {
  await fetch('/api/music/meta/ratings', {
    method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, stars, title, artist: artist ?? undefined }),
  })
}

export async function clearRating(ref: string): Promise<void> {
  await fetch(`/api/music/meta/ratings/${encodeURIComponent(ref)}`, { method: 'DELETE', credentials: 'include' })
}

/** React hook over getWaveform: the track's loudness envelope, null while unscanned/loading.
 *  Used by every Soundprint surface (immersive stage, mini strips). */
export function useWaveform(ref: string | null | undefined): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  useEffect(() => {
    if (!ref) { setPeaks(null); return }
    let alive = true
    setPeaks(null)
    void getWaveform(ref).then((p) => { if (alive) setPeaks(p) })
    return () => { alive = false }
  }, [ref])
  return peaks
}
