// Shared types for the podcast generation pipeline.

export type PodcastStyle = 'recap' | 'in-depth' | 'roundtable' | 'interview' | 'briefing' | 'story'

export interface ShowHost {
  characterId: string
  role: 'host' | 'co-host' | 'guest' | 'narrator'
}

export type SegmentType = 'youtube' | 'news' | 'sports' | 'weather' | 'onThisDay' | 'custom' | 'tvshow' | 'movie' | 'bookmarks'

export interface ShowSegment {
  type: SegmentType
  label?: string
  params?: Record<string, unknown>
}

export interface StingerConfig {
  introRelPath?: string
  outroRelPath?: string
  transitionRelPath?: string
}

export interface ShowConfig {
  id: string
  name: string
  description?: string | null
  style: PodcastStyle
  hosts: ShowHost[]
  segments: ShowSegment[]
  stinger?: StingerConfig
  ownerUserId: string
  // Overrides the style-default word count when set. 165 spoken words per minute.
  targetMinutes?: number | null
}

export interface ScriptTurn {
  host: string    // character id
  text: string
}

/** A host's persona for one show (internal — never shown in the UI). */
export interface CastMember {
  characterId: string
  name: string
  /** Role relative to the show's topic, e.g. "resident expert". Empty when personas don't apply. */
  role: string
  /** One vivid sentence of topic-relevant background. Empty when not applicable. */
  background: string
  /** How they sound on air ("dry and deadpan", "peppy and quick, says 'beep!'"). Derived
   *  from the character's companion personality — quirks kept, 1:1-chat framing dropped. */
  voice: string
  hobbies: string[]
  /** Rolling history of past per-episode personal beats (oldest→newest), capped. */
  beatHistory: string[]
}

export interface ShowCast {
  /** The subject the cast was built around. */
  topic: string
  members: CastMember[]
}

/** A per-episode personal "what's new" beat for one host. */
export interface EpisodeBeat {
  characterId: string
  name: string
  beat: string
  /** True when this host sits the episode out entirely (3+ host shows, occasional). */
  away: boolean
}

/** Persona context handed to the script/notes generators for a single episode. */
export interface CastBrief {
  members: {
    id: string
    name: string
    role: string
    background: string
    /** On-air speaking style (see CastMember.voice). */
    voice: string
    hobbies: string[]
    /** This episode's personal beat. */
    beat: string
    /** A couple of earlier-episode beats, so the others can recall/tease/follow up. */
    recent: string[]
    /** Per-video angle: how this host's role plays out for THIS specific content. */
    episodeAngle?: string
  }[]
  away: { name: string; beat: string }[]
}

export interface EpisodeChapter {
  title: string
  startSec: number
}

export interface PodcastGeneratePayload {
  showId: string
  episodeId: string
  userId: string
  userFirstName: string
  /** Per-episode content override (e.g. specific YouTube videos); falls back to the show's segments. */
  segments?: ShowSegment[]
}

// What each content adapter returns
export interface SegmentContent {
  label: string
  items: string[]    // plaintext bullet lines
  /** Source items used (e.g. YouTube videos), persisted for reverse "featured in podcasts" links. */
  sources?: { type: 'youtube'; id: string; title?: string }[]
}
