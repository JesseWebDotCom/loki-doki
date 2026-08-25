// MaiPai TV frontend API: types mirror backend/src/lib/tv/types.ts wire shapes.

import type { LucideIcon } from 'lucide-react'
import {
  Tv, Film, Repeat, Shuffle, Clapperboard, Disc3, Gamepad2, Images, Music2, RadioTower,
  Podcast, Mic, Shield, Cctv, Globe, Rocket, Flame, CloudSun, Gauge, Server, CalendarDays,
  PartyPopper, Trophy, MoonStar, PackageCheck, Newspaper, Sparkles, BookOpen, HelpCircle,
  Telescope, LayoutList,
} from 'lucide-react'

export type TvBlockKind = 'media' | 'live' | 'page' | 'audio' | 'segment' | 'filler' | 'offair'

export type TvScreenId =
  | 'guide' | 'weather' | 'calendar' | 'countdown' | 'sports' | 'net' | 'noc' | 'security'
  | 'memories' | 'arrivals' | 'news' | 'tonight' | 'nightsky' | 'onthisday' | 'fireside'

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

export interface TvChannel {
  id: string
  number: number
  slug: string
  name: string
  tagline: string | null
  kind: 'media' | 'live' | 'page' | 'audio' | 'segment'
  glyph: string
  color: string
  colorDark: string
  audience: 'everyone' | 'kids' | 'grownups'
  enabled: boolean
}

export interface TvBlock {
  id: string
  startAt: number
  endAt: number
  blockKind: TvBlockKind
  title: string
  subtitle: string | null
  art: string | null
  payload: TvBlockPayload
}

export interface TvNow {
  channel: TvChannel
  block: (TvBlock & { offsetSec: number }) | null
  next: TvBlock[]
}

export interface TvGuideChannel extends TvChannel {
  blocks: TvBlock[]
}

export interface TvGuide {
  from: number
  to: number
  channels: TvGuideChannel[]
}

export async function fetchTvChannels(): Promise<TvChannel[]> {
  const r = await fetch('/api/tv/channels', { credentials: 'include' })
  if (!r.ok) throw new Error('Failed to load channels')
  const data = await r.json() as { channels: TvChannel[] }
  return data.channels
}

export async function fetchTvNow(slug: string): Promise<TvNow> {
  const r = await fetch(`/api/tv/channels/${encodeURIComponent(slug)}/now`, { credentials: 'include' })
  if (!r.ok) throw new Error('Failed to load channel')
  return await r.json() as TvNow
}

export async function fetchTvGuide(hours = 4): Promise<TvGuide> {
  const r = await fetch(`/api/tv/guide?hours=${hours}`, { credentials: 'include' })
  if (!r.ok) throw new Error('Failed to load guide')
  return await r.json() as TvGuide
}

export function tvLogoUrl(slug: string): string {
  return `/api/tv/logo/${encodeURIComponent(slug)}.svg`
}

const TV_GLYPHS: Record<string, LucideIcon> = {
  Tv, Film, Repeat, Shuffle, Clapperboard, Disc3, Gamepad2, Images, Music2, RadioTower,
  Podcast, Mic, Shield, Cctv, Globe, Rocket, Flame, CloudSun, Gauge, Server, CalendarDays,
  PartyPopper, Trophy, MoonStar, PackageCheck, Newspaper, Sparkles, BookOpen, HelpCircle,
  Telescope, LayoutList,
}

export function tvGlyph(name: string): LucideIcon {
  return TV_GLYPHS[name] ?? Tv
}

/** Time label like "8:05" for guide rows and the info banner. */
export function tvClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
