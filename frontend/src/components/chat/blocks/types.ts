// Mirror of backend/src/lib/blocks.ts — keep in sync

export interface Source {
  url: string
  title: string
}

export interface WeatherDay {
  date: string
  high: number
  low: number
  precipMm: number
  code: number
}

export interface WeatherBlockData {
  location: string
  tempC: number
  tempF: number
  humidity: number
  precipMm: number
  windKph: number
  code: number
  forecast: WeatherDay[]
}

export interface YouTubeVideo {
  videoId: string
  title: string
  url: string
  snippet: string
  embedUrl: string
}

export interface YouTubeBlockData {
  videos: YouTubeVideo[]
}

export interface NewsItem {
  title: string
  url: string
  source: string
  published: string
  snippet: string
}

export interface NewsBlockData {
  category?: string
  items: NewsItem[]
}

export interface SearchResultItem {
  title: string
  snippet: string
  url: string
}

export interface SearchBlockData {
  results: SearchResultItem[]
  sources: Source[]
  inTheaters?: boolean
}

export interface CalcBlockData {
  expression: string
  result: number
  resultStr: string
}

export interface UnitConversionBlockData {
  value: number
  fromUnit: string
  toUnit: string
  result: number
  resultStr: string
  category: string
}

export interface RecipeBlockData {
  name: string
  category: string
  area: string
  thumbnail: string
  instructions: string
  ingredients: string[]
  youtube: string
  source: string
}

export interface DictionarySense {
  partOfSpeech: string
  definition: string
  example: string
}

export interface DictionaryBlockData {
  word: string
  phonetic: string
  senses: DictionarySense[]
}

export interface TvShowBlockData {
  name: string
  network: string
  status: string
  summary: string
  premiered: string
  ended: string
  genres: string[]
  rating: number | null
  seasonCount: number
  image: string
  url: string
  recentNews: Array<{ title: string; snippet: string; url: string }>
}

export interface JokeBlockData {
  joke: string
}

export interface ImageGenBlockData {
  imageId: string
  prompt: string
  status: 'building' | 'ready' | 'failed' | 'cancelled'
}

export interface DocumentEditBlockData {
  filename: string
  editedFilename: string
  instruction: string
  text: string
  downloadUrl: string
}

export interface WhereToWatchProvider {
  name: string
  offerType: string
  label: string
  url: string
}

export interface WhereToWatchItem {
  title: string
  year: number | null
  objectType: string
  posterUrl: string
  justwatchUrl: string
  providers: WhereToWatchProvider[]
}

export interface WhereToWatchBlockData {
  mode: 'lookup' | 'browse'
  country: string
  // lookup
  title?: string
  year?: number | null
  objectType?: string
  ageCertification?: string
  runtimeMinutes?: number | null
  posterUrl?: string
  justwatchUrl?: string
  providers?: WhereToWatchProvider[]
  theaters?: WhereToWatchProvider[]
  // browse (popular / new)
  browseLabel?: string
  provider?: string
  items?: WhereToWatchItem[]
}

export interface HolidayItem {
  name: string
  date: string
  weekday: string
}

export interface HolidaysBlockData {
  mode: 'lookup' | 'list'
  country: string
  year: number
  partial?: boolean
  holiday?: HolidayItem
  holidays?: HolidayItem[]
}

export interface ContentRatingCategory {
  label: string
  rating?: number // 0–5 filled dots
  detail?: string
}

export interface ContentRatingBlockData {
  title: string
  ageRating: string | null // e.g. "13+"
  parentsNeedToKnow: string | null
  categories: ContentRatingCategory[]
  url: string
  fallback: boolean
}

export interface PlayMusicVideo {
  videoId: string
  title: string
  artist: string | null
  thumbnail: string
  durationSec: number | null
}

export interface PlayMusicBlockData {
  query: string
  type: string
  topVideoId: string
  topTitle: string
  topArtist: string | null
  deeplink: string
  videos: PlayMusicVideo[]
}

export interface ArtifactBlockData {
  artifactId: string
  artifactType: 'code' | 'document' | 'html'
  title: string
  preview: string
}

export type Block =
  | { kind: 'weather'; data: WeatherBlockData }
  | { kind: 'content_rating'; data: ContentRatingBlockData }
  | { kind: 'youtube'; data: YouTubeBlockData }
  | { kind: 'news'; data: NewsBlockData }
  | { kind: 'search'; data: SearchBlockData }
  | { kind: 'calculator'; data: CalcBlockData }
  | { kind: 'unit_conversion'; data: UnitConversionBlockData }
  | { kind: 'recipe'; data: RecipeBlockData }
  | { kind: 'dictionary'; data: DictionaryBlockData }
  | { kind: 'tvshow'; data: TvShowBlockData }
  | { kind: 'joke'; data: JokeBlockData }
  | { kind: 'image_gen'; data: ImageGenBlockData }
  | { kind: 'where_to_watch'; data: WhereToWatchBlockData }
  | { kind: 'holidays'; data: HolidaysBlockData }
  | { kind: 'play_music'; data: PlayMusicBlockData }
  | { kind: 'document_edit'; data: DocumentEditBlockData }
  | { kind: 'artifact'; data: ArtifactBlockData }
