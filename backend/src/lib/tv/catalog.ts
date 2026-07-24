// The builtin Doki TV dial (plans/doki-tv.md). Seeded into tv_channels on boot;
// admin edits to enabled/name/config survive re-seeding (only missing rows are added).
// Frigate camera channels are seeded dynamically (numbers 20+) in seedChannels().

import type { TvAudience, TvChannelConfig, TvChannelKind } from './types'

export interface TvCatalogEntry {
  number: number
  slug: string
  name: string
  tagline: string
  kind: TvChannelKind
  glyph: string
  color: string
  colorDark: string
  audience?: TvAudience
  config: TvChannelConfig
}

export const CAMERA_CHANNEL_BASE = 20
export const CAMERA_CHANNEL_MAX = 8

export const TV_CATALOG: TvCatalogEntry[] = [
  // ── The guide itself (channel 1, the nostalgic centerpiece) ──────────────────
  {
    number: 1, slug: 'guide', name: 'Doki Guide', tagline: 'What is on, always on',
    kind: 'page', glyph: 'LayoutList', color: '#6d28d9', colorDark: '#2e1065',
    config: { kind: 'page', screen: 'guide', programMin: 60, programs: [{ fromHour: 0, title: 'Program Guide', subtitle: 'Scrolling listings for every channel' }] },
  },

  // ── Media library channels ───────────────────────────────────────────────────
  {
    number: 2, slug: 'movies', name: 'Doki Movies', tagline: 'The family film library, always rolling',
    kind: 'media', glyph: 'Film', color: '#dc2626', colorDark: '#450a0a',
    config: { kind: 'media', source: 'plex-movies', assumeMinutes: 110 },
  },
  {
    number: 3, slug: 'marathon', name: 'Marathon', tagline: 'One show, back to back, all week',
    kind: 'media', glyph: 'Repeat', color: '#ea580c', colorDark: '#431407',
    config: { kind: 'media', source: 'plex-marathon', assumeMinutes: 25 },
  },
  {
    number: 4, slug: 'shuffle', name: 'Shuffle TV', tagline: 'Any episode, any show, sitcom-block style',
    kind: 'media', glyph: 'Shuffle', color: '#d97706', colorDark: '#451a03',
    config: { kind: 'media', source: 'plex-episodes', assumeMinutes: 25 },
  },
  {
    number: 5, slug: 'creators', name: 'Creators', tagline: 'Your subscriptions, programmed like TV',
    kind: 'media', glyph: 'Clapperboard', color: '#e11d48', colorDark: '#4c0519',
    config: { kind: 'media', source: 'youtube-feed', minDurationSec: 240, assumeMinutes: 12 },
  },
  {
    number: 6, slug: 'music-video', name: 'Music Video', tagline: 'Videos by era, MTV style',
    kind: 'media', glyph: 'Disc3', color: '#db2777', colorDark: '#500724',
    config: {
      kind: 'media', source: 'youtube-search', assumeMinutes: 4, minDurationSec: 120, maxDurationSec: 600,
      queries: ['80s music videos official', '90s music videos official', '2000s music videos official', 'top music videos this year'],
    },
  },
  {
    number: 7, slug: 'longplays', name: 'Longplays', tagline: 'Retro game playthroughs, no commentary',
    kind: 'media', glyph: 'Gamepad2', color: '#9333ea', colorDark: '#3b0764',
    config: { kind: 'media', source: 'youtube-search', assumeMinutes: 60, minDurationSec: 1200, queries: ['retro game longplay no commentary', 'snes longplay', 'n64 longplay', 'ps1 longplay'] },
  },
  {
    number: 9, slug: 'memories', name: 'Memories', tagline: 'The family photo album, in motion',
    kind: 'page', glyph: 'Images', color: '#0d9488', colorDark: '#042f2e',
    config: { kind: 'page', screen: 'memories', programMin: 30, programs: [{ fromHour: 0, title: 'Family Memories', subtitle: 'Slideshows from the shared albums' }] },
  },

  // ── Audio channels ───────────────────────────────────────────────────────────
  {
    number: 11, slug: 'fm', name: 'Doki FM', tagline: 'Music with pictures, all day',
    kind: 'audio', glyph: 'Music2', color: '#7c3aed', colorDark: '#2e1065',
    config: {
      kind: 'audio', source: 'stations',
      stations: [
        { id: 'builtin:feel-good-classics', name: 'Feel-Good Classics', fromHour: 6 },
        { id: 'builtin:todays-hits', name: "Today's Hits", fromHour: 12 },
        { id: 'builtin:classic-rock', name: 'Classic Rock Highway', fromHour: 17 },
        { id: 'builtin:guilty-pleasures', name: 'Guilty Pleasures', fromHour: 21 },
      ],
    },
  },
  {
    number: 12, slug: 'radio-live', name: 'Live Radio', tagline: 'Real stations from the real airwaves',
    kind: 'audio', glyph: 'RadioTower', color: '#0891b2', colorDark: '#083344',
    config: { kind: 'audio', source: 'live-radio' },
  },
  {
    number: 13, slug: 'podcast', name: 'Podcast Network', tagline: 'Your shows on a broadcast clock',
    kind: 'audio', glyph: 'Podcast', color: '#4f46e5', colorDark: '#1e1b4b',
    config: { kind: 'audio', source: 'podcasts' },
  },
  {
    number: 14, slug: 'originals', name: 'Doki Originals', tagline: 'Podcasts this house made',
    kind: 'audio', glyph: 'Mic', color: '#c026d3', colorDark: '#4a044e',
    config: { kind: 'audio', source: 'ai-podcasts' },
  },

  // ── Live channels (cameras seed dynamically at 20+) ──────────────────────────
  {
    number: 28, slug: 'security-desk', name: 'Security Desk', tagline: 'Every camera, one wall',
    kind: 'page', glyph: 'Shield', color: '#475569', colorDark: '#0f172a', audience: 'grownups',
    config: { kind: 'page', screen: 'security', programMin: 60, programs: [{ fromHour: 0, title: 'Security Desk', subtitle: 'All cameras live with recent events' }] },
  },
  {
    number: 30, slug: 'window', name: 'The Window', tagline: 'Somewhere nice, live',
    kind: 'live', glyph: 'Globe', color: '#0284c7', colorDark: '#082f49',
    config: { kind: 'live', feeds: [], rotateMin: 30 },
  },
  {
    number: 31, slug: 'space', name: 'Space', tagline: 'Live from low Earth orbit',
    kind: 'live', glyph: 'Rocket', color: '#1d4ed8', colorDark: '#172554',
    config: { kind: 'live', feeds: [], rotateMin: 60 },
  },
  {
    number: 32, slug: 'fireside', name: 'Fireside', tagline: 'A warm hearth, always lit',
    kind: 'page', glyph: 'Flame', color: '#c2410c', colorDark: '#431407',
    config: { kind: 'page', screen: 'fireside', programMin: 60, programs: [{ fromHour: 0, title: 'The Hearth', subtitle: 'An ambient fireplace' }] },
  },

  // ── Dashboard channels ───────────────────────────────────────────────────────
  {
    number: 40, slug: 'weather', name: 'Weather 40', tagline: 'Local on the 8s',
    kind: 'page', glyph: 'CloudSun', color: '#0369a1', colorDark: '#082f49',
    config: {
      kind: 'page', screen: 'weather', programMin: 30,
      programs: [
        { fromHour: 5, title: 'Morning Forecast', subtitle: 'Today hour by hour' },
        { fromHour: 11, title: 'Midday Conditions', subtitle: 'Now and this afternoon' },
        { fromHour: 17, title: 'Evening Outlook', subtitle: 'Tonight and tomorrow' },
        { fromHour: 22, title: 'Overnight Weather', subtitle: 'The week ahead' },
      ],
    },
  },
  {
    number: 41, slug: 'net-health', name: 'Net Check', tagline: 'Is the internet okay?',
    kind: 'page', glyph: 'Gauge', color: '#059669', colorDark: '#022c22',
    config: { kind: 'page', screen: 'net', programMin: 30, programs: [{ fromHour: 0, title: 'Network Health', subtitle: 'Speed, latency and status' }] },
  },
  {
    number: 42, slug: 'noc', name: 'The NOC', tagline: 'The homelab wall',
    kind: 'page', glyph: 'Server', color: '#334155', colorDark: '#020617', audience: 'grownups',
    config: { kind: 'page', screen: 'noc', programMin: 60, programs: [{ fromHour: 0, title: 'Operations Center', subtitle: 'Server and integration status' }] },
  },
  {
    number: 44, slug: 'calendar', name: 'Family Calendar', tagline: 'Who has what, when',
    kind: 'page', glyph: 'CalendarDays', color: '#7c2d12', colorDark: '#431407',
    config: {
      kind: 'page', screen: 'calendar', programMin: 30,
      programs: [
        { fromHour: 5, title: 'Today at Home', subtitle: 'Everything on the calendar today' },
        { fromHour: 18, title: 'Tomorrow Preview', subtitle: 'What is coming up tomorrow' },
      ],
    },
  },
  {
    number: 45, slug: 'countdown', name: 'Countdown', tagline: 'Birthdays, holidays and big days',
    kind: 'page', glyph: 'PartyPopper', color: '#be185d', colorDark: '#500724',
    config: { kind: 'page', screen: 'countdown', programMin: 30, programs: [{ fromHour: 0, title: 'The Countdown Board', subtitle: 'Days until the good stuff' }] },
  },
  {
    number: 46, slug: 'sports', name: 'Sports Ticker', tagline: 'Scores for the teams you follow',
    kind: 'page', glyph: 'Trophy', color: '#15803d', colorDark: '#052e16',
    config: { kind: 'page', screen: 'sports', programMin: 30, programs: [{ fromHour: 0, title: 'The Ticker', subtitle: 'Today in sports' }] },
  },
  {
    number: 47, slug: 'night-sky', name: 'Night Sky', tagline: 'What is overhead tonight',
    kind: 'page', glyph: 'MoonStar', color: '#3730a3', colorDark: '#1e1b4b',
    config: { kind: 'page', screen: 'nightsky', programMin: 60, programs: [{ fromHour: 0, title: 'Tonight Overhead', subtitle: 'Moon, planets and stars' }] },
  },
  {
    number: 48, slug: 'arrivals', name: 'Arrivals', tagline: 'What the mail carrier knows',
    kind: 'page', glyph: 'PackageCheck', color: '#a16207', colorDark: '#422006',
    config: { kind: 'page', screen: 'arrivals', programMin: 30, programs: [{ fromHour: 0, title: 'Arrivals Board', subtitle: 'Package deliveries in and out' }] },
  },

  // ── AI network ───────────────────────────────────────────────────────────────
  {
    number: 60, slug: 'news', name: 'Doki News 60', tagline: 'Headlines around the clock',
    kind: 'page', glyph: 'Newspaper', color: '#b91c1c', colorDark: '#450a0a',
    config: {
      kind: 'page', screen: 'news', programMin: 30,
      programs: [
        { fromHour: 5, title: 'Morning Edition', subtitle: 'The headlines to start the day' },
        { fromHour: 12, title: 'Midday Report', subtitle: 'What is happening now' },
        { fromHour: 18, title: 'Evening News', subtitle: 'The day in review' },
        { fromHour: 23, title: 'Overnight Desk', subtitle: 'Rolling headlines' },
      ],
    },
  },
  {
    number: 61, slug: 'tonight', name: 'Family Tonight', tagline: 'The household newscast',
    kind: 'page', glyph: 'Sparkles', color: '#7e22ce', colorDark: '#3b0764',
    config: {
      kind: 'page', screen: 'tonight', programMin: 30,
      programs: [
        { fromHour: 6, title: 'Family Today', subtitle: 'Calendar, weather and deliveries' },
        { fromHour: 18, title: 'Family Tonight', subtitle: 'Tomorrow, photos of the day and more' },
      ],
    },
  },
  {
    number: 62, slug: 'story-time', name: 'Story Time', tagline: 'Bedtime stories, made for this house',
    kind: 'segment', glyph: 'BookOpen', color: '#0f766e', colorDark: '#042f2e', audience: 'kids',
    config: { kind: 'segment', segmentKind: 'program', comingSoon: 'Original bedtime stories are coming soon', signoff: { startHour: 21, endHour: 7 } },
  },
  {
    number: 63, slug: 'quiz', name: 'Quiz TV', tagline: 'The family game show channel',
    kind: 'segment', glyph: 'HelpCircle', color: '#ca8a04', colorDark: '#422006',
    config: { kind: 'segment', segmentKind: 'program', comingSoon: 'Game shows are in production' },
  },
  {
    number: 64, slug: 'rabbit-hole', name: 'Rabbit Hole', tagline: 'Deep dives into anything at all',
    kind: 'page', glyph: 'Telescope', color: '#4338ca', colorDark: '#1e1b4b',
    config: { kind: 'page', screen: 'onthisday', programMin: 30, programs: [{ fromHour: 0, title: 'On This Day', subtitle: 'History, one day at a time' }] },
  },
]
