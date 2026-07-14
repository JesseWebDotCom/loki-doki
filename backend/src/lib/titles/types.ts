// Shared types for the Shows and Movies apps. Both surface the same rich enrichment
// (streaming, trailers, reviews, trivia, parents guide, backdrop) over different metadata
// sources (TVMaze for shows, JustWatch for movies), so the enrichment shapes live here.

export type MediaKind = 'show' | 'movie'

export interface StreamProvider {
  name: string
  offerType: string // FLATRATE | RENT | BUY | FREE | ADS | CINEMA
  label: string
  url: string
  // Rental/purchase price like "$3.99" and the leaving-soon date (ISO), when JustWatch reports them.
  price?: string | null
  availableTo?: string | null
}

/** Real aggregate scores relayed by JustWatch (IMDb, TMDB, Rotten Tomatoes). */
export interface TitleScoring {
  imdbScore: number | null
  imdbVotes: number | null
  tmdbScore: number | null
  tomatoMeter: number | null
  certifiedFresh: boolean
}

export interface CastMember {
  name: string
  character: string
}

export interface SimilarTitle {
  title: string
  year: number | null
  objectType: string
  posterUrl: string
}

export type VideoKind = 'trailer' | 'clip' | 'theme' | 'soundtrack' | 'interview'

export interface VideoLink {
  videoId: string
  title: string
  author: string | null
  channelThumb: string | null
  thumbnailUrl: string | null
  durationSec: number | null
  kind: VideoKind
}

export interface PlatformLink {
  platform: string // "Apple Music", "Spotify", "YouTube Music", …
  url: string
}

export interface SoundtrackAlbum {
  name: string
  artist: string
  artworkUrl: string | null
  // Apple Music (from iTunes) always present; the rest resolved cross-platform via Odesli.
  links: PlatformLink[]
}

export interface TitleMedia {
  trailer: VideoLink | null
  clips: VideoLink[]
  music: VideoLink[]
  soundtrackAlbums: SoundtrackAlbum[]
}

export interface ReviewScore {
  source: string // "IMDb", "Rotten Tomatoes", "Metacritic"
  value: string // "8.5/10", "92%"
}

export interface ReviewDigest {
  summary: string
  pros: string[]
  cons: string[]
  scores: ReviewScore[]
  sources: { title: string; url: string }[]
}
