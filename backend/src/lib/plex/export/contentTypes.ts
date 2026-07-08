// The Plex-exportable content types — one private per-user show library each.
// 'youtube' is the original exporter (yt_plex_* tables, SponsorBlock cuts, shorts
// variants); the rest ride the generic exporter (video_plex_* tables). contentType
// doubles as the storage key (content_type_storage / plex_path_mappings) and the
// on-disk root segment: <storageRoot>/<contentType>/<userSlug>/...

export const PLEX_EXPORT_CONTENT_TYPES = ['youtube', 'tiktok', 'vimeo', 'reddit', 'mine'] as const
export type PlexExportContentType = (typeof PLEX_EXPORT_CONTENT_TYPES)[number]

/** Hub sources handled by the generic exporter (everything except YouTube). */
export const GENERIC_EXPORT_SOURCES = ['tiktok', 'vimeo', 'reddit', 'mine'] as const
export type GenericExportSource = (typeof GENERIC_EXPORT_SOURCES)[number]

/** Display name used for the Plex library section itself. */
export const SECTION_NAMES: Record<PlexExportContentType, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  vimeo: 'Vimeo',
  reddit: 'Reddit',
  mine: 'My Videos',
}

export function isPlexExportContentType(v: string): v is PlexExportContentType {
  return (PLEX_EXPORT_CONTENT_TYPES as readonly string[]).includes(v)
}

export function isGenericExportSource(v: string): v is GenericExportSource {
  return (GENERIC_EXPORT_SOURCES as readonly string[]).includes(v)
}

/** Default N for syncMode='recent' when syncRecentCount is null. */
export const DEFAULT_SYNC_RECENT_COUNT = 25
