// MaiPai TV shared types (plans/maipai-tv.md). A channel is config plus a materialized
// schedule; blocks carry a payload the frontend renderer (Path A) and the IPTV stream
// engine (Path B) both consume.

export type TvChannelKind = 'media' | 'live' | 'page' | 'audio' | 'segment'
export type TvBlockKind = TvChannelKind | 'filler' | 'offair'
export type TvAudience = 'everyone' | 'kids' | 'grownups'

/** Screens the frontend can mount for `page` blocks (components/tv/screens/). */
export type TvScreenId =
  | 'guide'
  | 'weather'
  | 'calendar'
  | 'countdown'
  | 'sports'
  | 'net'
  | 'noc'
  | 'security'
  | 'memories'
  | 'arrivals'
  | 'news'
  | 'tonight'
  | 'nightsky'
  | 'onthisday'
  | 'fireside'

export interface TvDaypartProgram {
  /** Hour of day (0-23) this program label starts applying. */
  fromHour: number
  title: string
  subtitle?: string
}

/** Overnight sign-off window (kids channels): offair blocks between startHour and endHour. */
export interface TvSignoff { startHour: number; endHour: number }

export type TvChannelConfig =
  | {
      kind: 'media'
      source: 'plex-movies' | 'plex-episodes' | 'plex-marathon' | 'youtube-feed' | 'youtube-search'
      /** youtube-search only: queries rotated by daypart/day seed. */
      queries?: string[]
      /** youtube filters (seconds). */
      minDurationSec?: number
      maxDurationSec?: number
      /** Fallback length for items with unknown duration (minutes). */
      assumeMinutes?: number
      signoff?: TvSignoff
    }
  | {
      kind: 'live'
      feeds: Array<{
        key: string
        label: string
        type: 'frigate' | 'hls' | 'mjpeg' | 'video-loop'
        /** hls/mjpeg/video-loop: source URL (admin-configurable). */
        url?: string
        /** frigate: camera name. */
        camera?: string
      }>
      /** Rotate between feeds every N minutes (default 30). */
      rotateMin?: number
      signoff?: TvSignoff
    }
  | {
      kind: 'page'
      screen: TvScreenId
      /** Program block length in minutes (default 30). */
      programMin?: number
      programs?: TvDaypartProgram[]
      signoff?: TvSignoff
    }
  | {
      kind: 'audio'
      source: 'stations' | 'live-radio' | 'podcasts' | 'ai-podcasts'
      /** stations: rotation of station ids/names by daypart. */
      stations?: Array<{ id: string; name: string; fromHour?: number }>
      signoff?: TvSignoff
    }
  | {
      kind: 'segment'
      segmentKind: 'program'
      /** Screen to fall back to while no ready segments exist. */
      fallbackScreen?: TvScreenId
      comingSoon?: string
      signoff?: TvSignoff
    }

export type TvBlockPayload =
  | { src: 'plex'; ratingKey: string; durationMs: number; thumb?: string | null }
  | { src: 'youtube'; videoId: string; durationSec: number; thumb?: string | null }
  | { src: 'live'; feed: { type: 'frigate' | 'hls' | 'mjpeg' | 'video-loop'; url?: string; camera?: string; label: string } }
  | { src: 'page'; screen: TvScreenId }
  | { src: 'station'; stationId: string; stationName: string }
  | { src: 'live-radio'; stationKey?: string; stationName?: string }
  | { src: 'podcast'; episodeId: string; showTitle?: string; durationSec: number; art?: string | null }
  | { src: 'segment'; segmentId: string }
  | { src: 'filler'; style: 'upnext' | 'ident'; nextTitle?: string }
  | { src: 'offair'; reason: 'not-configured' | 'coming-soon' | 'signoff'; message?: string }

export interface TvBlockRow {
  id: string
  channelId: string
  startAt: Date
  endAt: Date
  blockKind: TvBlockKind
  title: string
  subtitle: string | null
  art: string | null
  payload: TvBlockPayload
}

/** Wire shape for channel listings (frontend + IPTV builders). */
export interface TvChannelInfo {
  id: string
  number: number
  slug: string
  name: string
  tagline: string | null
  kind: TvChannelKind
  glyph: string
  color: string
  colorDark: string
  audience: TvAudience
  enabled: boolean
  config: TvChannelConfig
}
