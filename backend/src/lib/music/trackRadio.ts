// Track Radio - an ordered radio queue of similar tracks from the household collection,
// seeded by one song. Rides the music-intelligence similarity engine (1280-d discogs-effnet
// embeddings): the queue is the seed's sound-nearest analyzed tracks, most similar first.
// Degrades gracefully: a seed with no embedding first tries an identity match against the
// analyzed library (same song under another ref), then falls back to the station engine's
// song-seed path (YouTube Music radio mix), so the button always plays SOMETHING.

import { featureCount, getFeatureRow, nearestToVector, searchFeatures, type FeatureRow } from '@/lib/music/similarity'
import { buildStationQueue } from '@/lib/music/stationEngine'
import { logger } from '@/lib/logger'

export interface TrackRadioTrack { videoId: string; title: string; artist: string }
export interface TrackRadioResult {
  tracks: TrackRadioTrack[]
  source: 'similarity' | 'station-engine' | 'empty'
}

/** Enough analyzed tracks that "similar from your collection" is a real answer. */
const MIN_ANALYZED = 30
const QUEUE_LEN = 30

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** The seed's feature row: by ref, else by song identity (title/artist) so a YouTube play
 *  of a song the household also owns still radios off the owned copy's embedding. */
async function seedFeatureRow(ref: string, title?: string, artist?: string): Promise<FeatureRow | null> {
  const direct = await getFeatureRow(ref)
  if (direct) return direct
  if (!title) return null
  const nt = norm(title)
  const na = norm(artist)
  const candidates = await searchFeatures(title, 25)
  return candidates.find(r => norm(r.title) === nt && (!na || norm(r.artist) === na))
    ?? candidates.find(r => norm(r.title) === nt)
    ?? null
}

export async function buildTrackRadio(seed: { ref: string; title?: string; artist?: string }): Promise<TrackRadioResult> {
  // Similarity path: seed embedding known and the search space is meaningful.
  try {
    if (await featureCount() >= MIN_ANALYZED) {
      const row = await seedFeatureRow(seed.ref, seed.title, seed.artist)
      if (row) {
        const near = await nearestToVector(row.embedding, QUEUE_LEN, {
          maxPerArtist: 3, excludeRefs: [seed.ref, row.ref],
        })
        const tracks: TrackRadioTrack[] = [
          { videoId: seed.ref, title: seed.title ?? row.title ?? seed.ref, artist: seed.artist ?? row.artist ?? '' },
          ...near.filter(n => n.title || n.artist)
            .map(n => ({ videoId: n.ref, title: n.title ?? '', artist: n.artist ?? '' })),
        ]
        if (tracks.length >= 5) return { tracks, source: 'similarity' }
      }
    }
  } catch (err) {
    logger.debug(`[track-radio] similarity path failed: ${String(err)}`)
  }

  // Fallback: the station engine's song-seed path (YouTube Music radio mix off the song).
  try {
    const isYt = !seed.ref.includes(':')
    const label = `${seed.artist ?? ''} ${seed.title ?? ''}`.trim()
    const result = await buildStationQueue({
      name: seed.title ? `${seed.title} Radio` : 'Track Radio',
      aiPrompt: label ? `Songs like ${label}` : 'Similar songs',
      seedType: 'song',
      seedValue: label || undefined,
      seedVideoId: isYt ? seed.ref : undefined,
      count: QUEUE_LEN,
    })
    const tracks = result.tracks
      .filter(t => t.videoId !== seed.ref)
      .map(t => ({ videoId: t.videoId, title: t.title, artist: t.artist }))
    if (seed.title) tracks.unshift({ videoId: seed.ref, title: seed.title, artist: seed.artist ?? '' })
    return { tracks, source: tracks.length ? 'station-engine' : 'empty' }
  } catch (err) {
    logger.debug(`[track-radio] fallback failed: ${String(err)}`)
    return { tracks: [], source: 'empty' }
  }
}
