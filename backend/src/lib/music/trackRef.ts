// Unified music track reference — the seam that lets playlists/favorites/history/queues
// point at audio from any source through the existing videoId/refId columns:
//
//   `dQw4w9WgXcQ`                      bare (no ':')  → YouTube video id (every legacy row)
//   `local:<music_local_tracks.id>`                   → file indexed from a local library folder
//   `plex:<machineId>:<ratingKey>`                    → track on the connected Plex server
//
// The machineId inside a plex ref makes refs from a since-replaced server *detectably* dead
// (stream route 404s) instead of silently resolving against the wrong library.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets } from '@/db/schema'
import { blobAbsPath } from '@/lib/content/store'

export type TrackSource = 'youtube' | 'plex' | 'local'

export type ParsedRef =
  | { source: 'youtube'; videoId: string }
  | { source: 'local'; localId: string }
  | { source: 'plex'; machineId: string; ratingKey: string }

export const isYouTubeRef = (ref: string): boolean => !ref.includes(':')
export const localRef = (id: string): string => `local:${id}`
export const plexRef = (machineId: string, ratingKey: string): string => `plex:${machineId}:${ratingKey}`

export function parseTrackRef(ref: string): ParsedRef {
  if (!ref.includes(':')) return { source: 'youtube', videoId: ref }
  const [head, ...rest] = ref.split(':')
  if (head === 'local' && rest.length >= 1) return { source: 'local', localId: rest.join(':') }
  if (head === 'plex' && rest.length >= 2) {
    const ratingKey = rest[rest.length - 1]!
    return { source: 'plex', machineId: rest.slice(0, -1).join(':'), ratingKey }
  }
  // Unknown prefix — treat the whole string as a YouTube id so legacy odd data degrades to
  // today's behavior instead of throwing deep inside a queue build.
  return { source: 'youtube', videoId: ref }
}

// ── Audio-source registry ─────────────────────────────────────────────────────────
// Lets cross-cutting consumers (loudness scan, feature analysis) read the audio bytes
// behind any ref without knowing source internals. Sources register at module init;
// the youtube resolver is registered below, local/plex register from their own modules.

export interface AudioStreamMeta {
  codec: string | null
  bitrateKbps: number | null
  sampleRate: number | null
  bitDepth: number | null
}

export interface AudioSourceResolver {
  /** Absolute path to an on-disk audio file for this ref, or null when not locally available. */
  audioFilePath(ref: ParsedRef): Promise<string | null>
  /** Real codec/bitrate facts for the Now Playing badge, when the source knows them. */
  streamMeta?(ref: ParsedRef): Promise<AudioStreamMeta | null>
}

const sources = new Map<TrackSource, AudioSourceResolver>()

export function registerAudioSource(source: TrackSource, resolver: AudioSourceResolver): void {
  sources.set(source, resolver)
}

/** Absolute path of an audio file for `ref`, from whichever source owns it. Null when the
 *  audio isn't on disk (never downloaded, prefetch evicted, remote-only Plex track…). */
export async function resolveAudioFile(ref: string): Promise<string | null> {
  const parsed = parseTrackRef(ref)
  const resolver = sources.get(parsed.source)
  if (!resolver) return null
  try { return await resolver.audioFilePath(parsed) } catch { return null }
}

/** Codec/bitrate facts for `ref` when the owning source can report them. */
export async function resolveStreamMeta(ref: string): Promise<AudioStreamMeta | null> {
  const parsed = parseTrackRef(ref)
  const resolver = sources.get(parsed.source)
  if (!resolver?.streamMeta) return null
  try { return await resolver.streamMeta(parsed) } catch { return null }
}

// YouTube: audio lives in the shared content-addressed blob store when any user saved /
// prefetched it (mediaAssets kind='audio'). No streamMeta — the streaming path's codec is
// reported by the stream resolver, not here.
registerAudioSource('youtube', {
  async audioFilePath(parsed) {
    if (parsed.source !== 'youtube') return null
    const [asset] = await db.select({ blobHash: mediaAssets.blobHash, status: mediaAssets.status })
      .from(mediaAssets)
      .where(and(
        eq(mediaAssets.sourceType, 'youtube'),
        eq(mediaAssets.sourceId, parsed.videoId),
        eq(mediaAssets.kind, 'audio'),
        eq(mediaAssets.status, 'ready'),
      ))
      .limit(1)
    if (!asset?.blobHash) return null
    return blobAbsPath(asset.blobHash)
  },
})
