// Deterministic Plex-tree layout — pure functions, no DB/filesystem access. Given the same
// inputs these always produce the same names, so placement is idempotent (re-running sync
// for a video that's already placed is a safe no-op check, not a duplicate).

import { join } from 'node:path'
import { sanitizeFilename } from './sanitize'

export function showFolderName(channelTitle: string, variant: 'main' | 'shorts'): string {
  const base = sanitizeFilename(channelTitle || 'Unknown Channel')
  return variant === 'shorts' ? `${base} — Shorts` : base
}

export function seasonFolderName(seasonYear: number): string {
  const y = seasonYear > 0 ? seasonYear : 0
  return `Season ${String(y).padStart(4, '0')}`
}

export function seasonFolderRelPath(channelTitle: string, variant: 'main' | 'shorts', seasonYear: number): string {
  return join(showFolderName(channelTitle, variant), seasonFolderName(seasonYear))
}

export interface EpisodeFileNames {
  video: string
  nfo: string
  thumb: string
  srt(lang: string): string
}

/** `episodeNumber` must already be resolved unique-within-(show,season) by the caller —
 *  this module has no DB access to check that itself. videoId is embedded in the shared
 *  stem so two videos with an identical sanitized title can never collide, and so every
 *  sidecar (nfo/thumb/srt) matches its video by Plex's basename convention automatically. */
export function episodeFileNames(showTitle: string, seasonYear: number, episodeNumber: number, videoId: string, title: string): EpisodeFileNames {
  const season = String(seasonYear > 0 ? seasonYear : 0).padStart(4, '0')
  const ep = String(episodeNumber).padStart(4, '0')
  const stem = `${sanitizeFilename(showTitle)} - S${season}E${ep} - ${videoId} - ${sanitizeFilename(title || videoId)}`
  return {
    video: `${stem}.mp4`,
    nfo: `${stem}.nfo`,
    thumb: `${stem}-thumb.jpg`,
    srt: (lang: string) => `${stem}.${lang}.srt`,
  }
}
