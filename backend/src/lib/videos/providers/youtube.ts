// YouTube provider: a thin adapter over the existing lib/youtube stack (InnerTube,
// discovery, comments). Wrap, never rewrite: the standalone YouTube plumbing
// (yt_* tables, RSS poller, /api/youtube routes) stays authoritative; this adapter
// only exposes YouTube to hub-level surfaces (mixed home, universal clipper, search).

import {
  innertubeSearch, innertubeSearchMore, innertubeChannel, innertubePlayerMeta,
  innertubeComments, tryInnertube,
} from '@/lib/youtube/innertube'
import type { ItVideo } from '@/lib/youtube/innertube'
import { fetchTrending } from '@/lib/youtube/discovery'
import type { VideoProvider } from '@/lib/videos/provider'
import type { VideoItem } from '@/lib/videos/types'

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

function toItem(v: ItVideo): VideoItem {
  return {
    source: 'youtube',
    id: v.videoId,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    title: v.title,
    creator: v.channelId ? { id: v.channelId, name: v.author ?? '', avatarUrl: v.channelThumb } : null,
    thumbnailUrl: v.thumbnailUrl,
    durationSec: v.durationSec,
    publishedText: v.publishedText,
    viewsText: v.views,
  }
}

export const youtubeProvider: VideoProvider = {
  source: 'youtube',
  label: 'YouTube',
  capabilities: {
    browse: true,
    search: true,
    creators: true,
    comments: true,
    live: true,
    downloadKinds: ['audio', 'video'],
    authConfig: 'none',
  },

  matchUrl(url) {
    const host = url.hostname.replace(/^www\.|^m\./, '')
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0] ?? ''
      return VIDEO_ID.test(id) ? { kind: 'video', id } : null
    }
    if (host !== 'youtube.com' && host !== 'music.youtube.com') return null
    const v = url.searchParams.get('v')
    if (v && VIDEO_ID.test(v)) return { kind: 'video', id: v }
    const parts = url.pathname.split('/').filter(Boolean)
    if ((parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') && parts[1] && VIDEO_ID.test(parts[1])) {
      return { kind: 'video', id: parts[1] }
    }
    if (parts[0] === 'channel' && parts[1]?.startsWith('UC')) return { kind: 'creator', id: parts[1] }
    return null
  },

  async browse({ cursor }) {
    // Hub browse = trending; personalized subscription feeds stay in the YouTube area.
    if (cursor) return { items: [], cursor: null }
    const videos = await tryInnertube('videos-hub-trending', () => fetchTrending(40), [] as ItVideo[])
    return { items: videos.map(toItem), cursor: null }
  },

  async search(q, { cursor }) {
    const res = cursor
      ? await innertubeSearchMore(cursor, 20)
      : await innertubeSearch(q, 20)
    return { items: res.videos.map(toItem), cursor: res.continuation }
  },

  async getCreator(id, cursor) {
    const page = await innertubeChannel(id, cursor ?? null, 30)
    return {
      creator: {
        source: 'youtube',
        kind: 'channel',
        id,
        name: page.meta?.title ?? '',
        handle: page.meta?.handle,
        avatarUrl: page.meta?.thumbnailUrl,
        bannerUrl: page.meta?.bannerUrl,
        description: page.meta?.description,
        subscriberText: page.meta?.subscribers,
      },
      videos: { items: page.videos.map(toItem), cursor: page.continuation },
    }
  },

  async getItem(id) {
    if (!VIDEO_ID.test(id)) return null
    const meta = await innertubePlayerMeta(id)
    if (!meta) return null
    return {
      source: 'youtube',
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: meta.title,
      creator: meta.channelId ? { id: meta.channelId, name: meta.author ?? '' } : null,
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      durationSec: meta.durationSec,
      viewsText: meta.views,
      live: meta.isLive,
      description: meta.description,
    }
  },

  async getPlayback() {
    return { mode: 'native-app' }
  },

  async getComments(id) {
    const comments = await innertubeComments(id, 20)
    return comments.map((cm) => ({
      author: cm.author,
      text: cm.text,
      likes: cm.likeCount,
      publishedText: cm.publishedText,
    }))
  },

  async downloadSpec(id) {
    return { url: `https://www.youtube.com/watch?v=${id}` }
  },
}
