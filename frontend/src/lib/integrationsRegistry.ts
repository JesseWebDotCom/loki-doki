// Metadata registry for every external-service integration: what it is, which app owns
// its colocated settings, and where its admin detail view lives. Deliberately metadata
// only (no component field): each surface statically imports the shared config component
// it embeds, so importing this registry never drags a heavy admin tab into an app page.
// The Integrations hub (AdminIntegrationsOverview) renders this as a status card grid.

import type { LucideIcon } from 'lucide-react'
import { Activity, BookOpen, Cctv, Clapperboard, Cloud, Download, Home, MonitorPlay, Send, Tv } from 'lucide-react'

export type IntegrationCategory = 'media' | 'smart-home' | 'monitoring' | 'reading' | 'personal'

export interface IntegrationDef {
  id: 'plex' | 'sonarr' | 'radarr' | 'overseerr' | 'sabnzbd' | 'home-assistant' | 'frigate' | 'uptime-kuma' | 'opds' | 'apple-icloud'
  label: string
  icon: LucideIcon
  category: IntegrationCategory
  /** One line: what connecting this powers. */
  blurb: string
  /** App whose settings page hosts the colocated admin config; null = hub only. */
  ownerAppLabel: string | null
  appSettingsHref: string | null
  /** Subsection id under /admin/integrations/ for the full management view. */
  adminSub: string
  keywords: string[]
}

export const INTEGRATION_CATEGORIES: Record<IntegrationCategory, string> = {
  media: 'Media',
  'smart-home': 'Smart Home',
  monitoring: 'Monitoring',
  reading: 'Reading',
  personal: 'Personal',
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'plex', label: 'Plex', icon: MonitorPlay, category: 'media',
    blurb: 'Shared media server: library rails, Watchlist sync, and in-app playback',
    ownerAppLabel: 'Movies', appSettingsHref: '/movies/settings', adminSub: 'plex',
    keywords: ['plex', 'media server', 'watchlist', 'library'],
  },
  {
    id: 'sonarr', label: 'Sonarr', icon: Tv, category: 'media',
    blurb: 'TV show downloads and the Shows library calendar',
    ownerAppLabel: 'Shows', appSettingsHref: '/apps/shows/settings/admin', adminSub: 'sonarr',
    keywords: ['sonarr', 'tv', 'shows', 'arr'],
  },
  {
    id: 'radarr', label: 'Radarr', icon: Clapperboard, category: 'media',
    blurb: 'Movie downloads and the Movies release calendar',
    ownerAppLabel: 'Movies', appSettingsHref: '/movies/settings', adminSub: 'radarr',
    keywords: ['radarr', 'movies', 'arr'],
  },
  {
    id: 'overseerr', label: 'Overseerr', icon: Send, category: 'media',
    blurb: 'Household request pipeline with per-user Plex attribution',
    ownerAppLabel: 'Shows', appSettingsHref: '/apps/shows/settings/admin', adminSub: 'overseerr',
    keywords: ['overseerr', 'requests', 'jellyseerr'],
  },
  {
    id: 'sabnzbd', label: 'SABnzbd', icon: Download, category: 'media',
    blurb: 'Usenet download client behind Sonarr and Radarr',
    ownerAppLabel: null, appSettingsHref: null, adminSub: 'sabnzbd',
    keywords: ['sabnzbd', 'usenet', 'nzb', 'downloads'],
  },
  {
    id: 'home-assistant', label: 'Home Assistant', icon: Home, category: 'smart-home',
    blurb: 'Smart-home control through the companion and the Home Assistant app',
    ownerAppLabel: 'Home Assistant', appSettingsHref: '/home-assistant/settings', adminSub: 'home-assistant',
    keywords: ['home assistant', 'hass', 'smart home', 'iot'],
  },
  {
    id: 'frigate', label: 'Frigate', icon: Cctv, category: 'smart-home',
    blurb: 'NVR camera events, announcements, and the GenAI shim',
    ownerAppLabel: 'Cameras', appSettingsHref: '/apps/cameras/settings/admin', adminSub: 'frigate',
    keywords: ['frigate', 'nvr', 'camera', 'cctv'],
  },
  {
    id: 'uptime-kuma', label: 'Uptime Kuma', icon: Activity, category: 'monitoring',
    blurb: 'Service health alerts and companion announcements when something goes down',
    ownerAppLabel: null, appSettingsHref: null, adminSub: 'monitoring',
    keywords: ['uptime', 'kuma', 'monitoring', 'alerts'],
  },
  {
    id: 'apple-icloud', label: 'Apple iCloud', icon: Cloud, category: 'personal',
    blurb: 'Family calendars and mail from each member\'s Apple Account, synced locally',
    ownerAppLabel: null, appSettingsHref: null, adminSub: 'apple-icloud',
    keywords: ['icloud', 'apple', 'calendar', 'caldav', 'mail', 'imap', 'app-specific password'],
  },
  {
    id: 'opds', label: 'Book Indexers', icon: BookOpen, category: 'reading',
    blurb: 'Self-hosted OPDS catalogs (Calibre-Web, Kavita) as extra Book Store sources',
    ownerAppLabel: 'Books', appSettingsHref: '/books/sources', adminSub: 'books',
    keywords: ['opds', 'calibre', 'kavita', 'books', 'indexer'],
  },
]
