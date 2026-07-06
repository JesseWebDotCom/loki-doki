// Content-type-aware storage root resolution — additive layer on top of paths.ts's
// single default data root. A content type (or, for the blob store, a specific blob)
// can be assigned a different storage_locations row; everything not explicitly
// assigned keeps resolving against getDataRoot() exactly as before.
//
// Deliberately NOT folded into paths.ts's resolveUserPath/toRelativePath/userPath —
// those 17 existing call sites (podcast/music/converter/image/etc.) stay untouched.
// Only code that needs to know about MULTIPLE possible roots (the blob store, and
// the Plex export pipeline) imports from here.

import { join, isAbsolute, relative } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { contentTypeStorage, storageLocations, plexPathMappings } from '@/db/schema'
import { getDataRoot } from '@/lib/storage/paths'

/** Join `parts` under `root` and assert the result stays inside `root`. */
export function joinUnderRoot(root: string, ...parts: string[]): string {
  const abs = join(root, ...parts)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes root: ${parts.join('/')}`)
  }
  return abs
}

/** Absolute path of a storage location, or the default data root if id is null/unknown
 *  (e.g. the location was since deleted — fail safe to the default rather than throw). */
export async function getStorageLocationPath(storageLocationId: string | null | undefined): Promise<string> {
  if (!storageLocationId) return getDataRoot()
  const [loc] = await db.select().from(storageLocations).where(eq(storageLocations.id, storageLocationId)).limit(1)
  return loc?.path ?? await getDataRoot()
}

/** The storage_location id currently assigned to a content type, or null (= default root). */
export async function getContentTypeStorageLocationId(contentType: string): Promise<string | null> {
  const [row] = await db.select().from(contentTypeStorage).where(eq(contentTypeStorage.contentType, contentType)).limit(1)
  return row?.storageLocationId ?? null
}

/** Absolute root a content type's real files should live under right now. */
export async function getRootForContentType(contentType: string): Promise<string> {
  return getStorageLocationPath(await getContentTypeStorageLocationId(contentType))
}

export async function resolveContentTypePath(contentType: string, ...relParts: string[]): Promise<string> {
  return joinUnderRoot(await getRootForContentType(contentType), ...relParts)
}

export async function toContentTypeRelativePath(contentType: string, absPath: string): Promise<string> {
  if (!isAbsolute(absPath)) return absPath
  const root = await getRootForContentType(contentType)
  return relative(root, absPath)
}

/**
 * Translate an absolute app-side path under a storage location into how Plex's own OS
 * process sees the same bytes, via that location's plex_path_mappings row. Returns null
 * when there's nothing to translate — either the path is still on the (never Plex-visible
 * by definition) default local root, or no mapping has been configured for this location
 * yet. Output is always POSIX-style (forward slashes): Plex Media Server is typically
 * Linux/Unix-hosted even when the app itself runs on Windows, so a plain `path.join` on
 * the app's own OS would corrupt a `\mnt\x`-shaped mapping — segments are recombined
 * manually instead of relying on OS-specific path semantics for the Plex-side half.
 */
export async function toPlexPath(storageLocationId: string | null | undefined, appAbsPath: string): Promise<string | null> {
  if (!storageLocationId) return null
  const root = await getStorageLocationPath(storageLocationId)
  const relRaw = relative(root, appAbsPath)
  if (relRaw.startsWith('..') || isAbsolute(relRaw)) {
    throw new Error(`path escapes root: ${appAbsPath}`)
  }
  const [mapping] = await db.select().from(plexPathMappings).where(eq(plexPathMappings.storageLocationId, storageLocationId)).limit(1)
  if (!mapping) return null
  const relParts = relRaw.split(/[\\/]+/).filter(Boolean)
  const base = mapping.plexPath.replace(/[\\/]+$/, '')
  return [base, ...relParts].join('/')
}
