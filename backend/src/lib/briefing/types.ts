// Ambient daily-briefing data model.
//
// A BriefingPayload is the structured world/local context for ONE location, refreshed
// in the background (never on the companion request path). `renderBriefingBlock()` turns
// it into a short prompt block that rides every companion turn — see render.ts for the
// token budget. Each source that fails this cycle is recorded in `degraded[]` and its
// section is simply dropped (graceful degradation, like the holidays tool offline path).

export interface BriefingItem {
  title: string
  detail?: string
  url?: string
  // Optional rich fields for UI cards (ignored by the text briefing renderer).
  imageUrl?: string
  summary?: string
  publishedAt?: number // epoch ms
}

export interface BriefingPayload {
  location: string // displayName, e.g. "Milford, CT" (or "__default__")
  generatedAt: number // epoch ms
  date: string // "Saturday, June 14, 2026"
  weather?: string // one-line summary, e.g. "72°F, partly cloudy, high 78°F"
  holidays: BriefingItem[]
  localNews: BriefingItem[]
  localEvents: BriefingItem[]
  worldNews: BriefingItem[]
  sports: BriefingItem[]
  notableDeaths: BriefingItem[]
  onThisDay: BriefingItem[]
  plex: BriefingItem[] // recently added to the user's Plex library
  degraded: string[] // source ids that failed/were disabled this cycle
}

import type { DataSource } from '@/tools/index'
export type { DataSource }

export type BriefingSourceId =
  | 'weather'
  | 'worldNews'
  | 'localNews'
  | 'localEvents'
  | 'sports'
  | 'onThisDay'
  | 'notableDeaths'
  | 'holidays'
  | 'plex'

export const BRIEFING_SOURCE_IDS: BriefingSourceId[] = [
  'weather',
  'worldNews',
  'localNews',
  'localEvents',
  'sports',
  'onThisDay',
  'notableDeaths',
  'holidays',
  'plex',
]

/** Display names for each briefing source, shown in the setup wizard and privacy audit. */
export const BRIEFING_SOURCE_LABELS: Record<BriefingSourceId, string> = {
  weather:      'Weather',
  worldNews:    'World News',
  localNews:    'Local News',
  localEvents:  'Local Events',
  sports:       'Sports Scores',
  onThisDay:    'On This Day',
  notableDeaths:'Notable Deaths',
  holidays:     'Holidays',
  plex:         'New on Plex',
}

/** External data sources contacted by each briefing source. */
export const BRIEFING_SOURCE_MANIFEST: Record<BriefingSourceId, DataSource[]> = {
  weather: [
    { name: 'Open-Meteo', domain: 'open-meteo.com', purpose: 'Local weather conditions and forecast', type: 'api' },
    { name: 'Open-Meteo Geocoding', domain: 'geocoding-api.open-meteo.com', purpose: 'Converts location names to coordinates', type: 'api' },
  ],
  worldNews: [
    { name: 'NY Times', domain: 'rss.nytimes.com', purpose: 'World news headlines', type: 'rss' },
    { name: 'The Guardian', domain: 'theguardian.com', purpose: 'World news headlines', type: 'rss' },
    { name: 'BBC News', domain: 'feeds.bbci.co.uk', purpose: 'World news headlines', type: 'rss' },
  ],
  localNews: [
    { name: 'Google News', domain: 'news.google.com', purpose: 'Local news search fallback (no location set up)', type: 'rss' },
    { name: 'Bing News', domain: 'bing.com', purpose: 'Local news search, real per-article images (when consented)', type: 'rss' },
    { name: 'Patch.com', domain: 'patch.com', purpose: 'Hyperlocal town news (when consented)', type: 'web' },
    { name: 'Daily Voice', domain: 'dailyvoice.com', purpose: 'Hyperlocal town news via RSS, CT/NY/NJ/PA/MA only (when consented)', type: 'rss' },
  ],
  localEvents: [
    { name: 'Google News', domain: 'news.google.com', purpose: 'Local event listings search', type: 'rss' },
  ],
  sports: [
    { name: 'ESPN', domain: 'espn.com', purpose: 'Live scores and schedules across major leagues', type: 'api' },
  ],
  onThisDay: [
    { name: 'Wikimedia', domain: 'wikimedia.org', purpose: 'Historical events and notable births on this date', type: 'api' },
  ],
  notableDeaths: [
    { name: 'Google News', domain: 'news.google.com', purpose: 'Recent notable deaths in the news', type: 'rss' },
  ],
  holidays: [
    { name: 'Nager.Date', domain: 'date.nager.at', purpose: "Today's public holidays", type: 'api' },
  ],
  plex: [
    { name: 'Plex', domain: 'plex.tv', purpose: 'Recently added to your media server', type: 'api' },
  ],
}
