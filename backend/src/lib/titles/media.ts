// Trailers, clips, and theme/soundtrack music for a title — sourced keylessly from YouTube
// via InnerTube. Cached for a week (these don't churn). Best-effort: any sub-search that
// fails just yields fewer results; the page still renders.

import { innertubeSearch, type ItVideo } from '@/lib/youtube/innertube'
import { cachedLookup } from '@/lib/lookupCache'
import { getSoundtrackAlbums } from './soundtrack'
import type { MediaKind, TitleMedia, VideoKind, VideoLink } from './types'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

async function searchVideos(query: string, limit: number): Promise<ItVideo[]> {
  try {
    const r = await innertubeSearch(query, limit)
    return r.videos
  } catch {
    return []
  }
}

function toLink(v: ItVideo, kind: VideoKind): VideoLink {
  return {
    videoId: v.videoId,
    title: v.title,
    author: v.author,
    channelThumb: v.channelThumb,
    thumbnailUrl: v.thumbnailUrl,
    durationSec: v.durationSec,
    kind,
  }
}

// Drop near-duplicate videos (same id) and full-length-looking results from a clip search.
function dedupe(videos: VideoLink[], seen: Set<string>): VideoLink[] {
  const out: VideoLink[] = []
  for (const v of videos) {
    if (!v.videoId || seen.has(v.videoId)) continue
    seen.add(v.videoId)
    out.push(v)
  }
  return out
}

export async function getTitleMedia(title: string, year: string | null, kind: MediaKind): Promise<TitleMedia> {
  // v3: adds soundtrackAlbums (cross-platform links). v2 added channelThumb.
  const key = `v3:${kind}:${title.toLowerCase()}:${year ?? ''}`
  return cachedLookup('title-media', key, ONE_WEEK_MS, async () => {
    const y = year ? ` ${year}` : ''
    const [trailerVids, clipVids, musicVids, soundtrackAlbums] = await Promise.all([
      searchVideos(`${title}${y} ${kind === 'movie' ? 'official trailer' : 'official trailer'}`, 3),
      searchVideos(kind === 'show' ? `${title} best scenes` : `${title}${y} movie clip`, 6),
      searchVideos(kind === 'show' ? `${title} theme song opening` : `${title}${y} soundtrack`, 4),
      getSoundtrackAlbums(title, year, kind),
    ])

    const seen = new Set<string>()
    const trailerLinks = dedupe(trailerVids.map((v) => toLink(v, 'trailer')), seen)
    const trailer = trailerLinks[0] ?? null
    const clips = dedupe(clipVids.map((v) => toLink(v, 'clip')), seen).slice(0, 6)
    const music = dedupe(musicVids.map((v) => toLink(v, kind === 'show' ? 'theme' : 'soundtrack')), seen).slice(0, 4)

    return { trailer, clips, music, soundtrackAlbums }
  })
}
