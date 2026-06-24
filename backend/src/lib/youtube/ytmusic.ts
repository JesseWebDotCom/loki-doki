// YouTube Music (WEB_REMIX) InnerTube client. We use exactly one thing from it: an
// auto-curated "radio" mix seeded from a song. YouTube Music's radio is purpose-built for
// exactly what the AI Radio wants — a long, varied, genre/artist-appropriate queue that
// keeps going — which is far better variety than re-ranking one search query's top hits.
//
// Playback is unchanged: every track is an ordinary videoId played through our existing
// /api/youtube/stream proxy. This module only sources the queue.

import { logger } from '@/lib/logger'

const BASE = 'https://music.youtube.com/youtubei/v1'
// Same public InnerTube key youtube.com / music.youtube.com ship to every visitor.
const KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
const MUSIC_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20240403.01.00', hl: 'en', gl: 'US' }
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface MusicTrack { videoId: string; title: string; author: string | null }

async function musicCall(endpoint: string, body: Record<string, unknown>, timeout: number): Promise<any> {
  const res = await fetch(`${BASE}/${endpoint}?key=${KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Youtube-Client-Name': '67',
      'X-Youtube-Client-Version': MUSIC_CLIENT.clientVersion,
      Origin: 'https://music.youtube.com',
      Referer: 'https://music.youtube.com/',
    },
    body: JSON.stringify({ context: { client: MUSIC_CLIENT }, ...body }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`ytmusic ${endpoint} → ${res.status}`)
  return res.json()
}

// Depth-first collect every value under a given renderer key.
function collect(node: any, key: string, out: any[], limit: number): void {
  if (out.length >= limit || node == null || typeof node !== 'object') return
  for (const k of Object.keys(node)) {
    if (k === key) { out.push(node[k]); if (out.length >= limit) return }
    else collect(node[k], key, out, limit)
  }
}

/**
 * The radio mix seeded from a song — `next` endpoint with the RDAMVM<id> radio playlist.
 * Returns a long, deduped list of tracks (typically ~25, more via continuations we don't
 * bother paging here). Returns [] on any failure so callers can fall back to plain search.
 */
export async function ytmusicRadio(seedVideoId: string, timeout = 9000): Promise<MusicTrack[]> {
  try {
    const data = await musicCall('next', {
      videoId: seedVideoId,
      playlistId: `RDAMVM${seedVideoId}`,
      params: 'wAEB',          // enable radio
      isAudioOnly: true,
      watchEndpointMusicSupportedConfigs: {
        watchEndpointMusicConfig: { hasPersistentPlaylistPanel: true, musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
      },
    }, timeout)

    const items: any[] = []
    collect(data, 'playlistPanelVideoRenderer', items, 200)
    const seen = new Set<string>()
    const tracks: MusicTrack[] = []
    for (const it of items) {
      const videoId: string | undefined = it.videoId
      if (!videoId || seen.has(videoId)) continue
      const title: string | null = it.title?.runs?.[0]?.text ?? null
      if (!title) continue
      // byline runs are "Artist • Album • Views" — the first run is the primary artist.
      const author: string | null =
        it.shortBylineText?.runs?.[0]?.text ??
        it.longBylineText?.runs?.[0]?.text ?? null
      seen.add(videoId)
      tracks.push({ videoId, title, author })
    }
    return tracks
  } catch (err) {
    logger.debug(`[ytmusic] radio(${seedVideoId}) failed: ${String(err)}`)
    return []
  }
}
