// Central user-content path resolver.
//
// Global assets (models, ZIM archives, maps, voice) keep using dataDir from
// lib/download.ts directly — they are shared across all users and survive
// independently. This module only governs *per-user* content: generated images,
// YouTube downloads, podcast episodes, etc.
//
// The admin can relocate user data to a network share or external drive via
// Admin → Storage. Paths stored in the DB are relative to the data root so a
// root change doesn't invalidate existing references — use resolveUserPath() to
// turn a stored relative path into an absolute one.

import { mkdir } from 'node:fs/promises'
import { join, isAbsolute, relative, dirname } from 'node:path'
import { dataDir } from '@/lib/download'
import { getAppSetting } from '@/lib/settings'

// Join `parts` under `root` and assert the result stays inside `root` — defense-in-depth
// so a `..`-bearing stored relPath or path component can't escape the data root.
function containedJoin(root: string, ...parts: string[]): string {
  const abs = join(root, ...parts)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes data root: ${parts.join('/')}`)
  }
  return abs
}

// ── User content categories ───────────────────────────────────────────────────

export type UserCategory =
  | 'images'
  | 'youtube/audio'
  | 'youtube/video'
  | 'youtube/transcripts'
  | 'podcasts'
  | 'music'
  | 'documents'

// ── Root resolution ───────────────────────────────────────────────────────────

/** Absolute path of the user data root (default: data/users/). Reads the admin
 *  setting `storage.user_data_root`; falls back to the default on first boot. */
export async function getDataRoot(): Promise<string> {
  const setting = await getAppSetting('storage.user_data_root') as string | null
  return setting ?? join(dataDir, 'users')
}

/** Stable slug for a user — firstName lowercased + last 6 chars of their id.
 *  Stable: renaming the user in the app does not change their folder. */
export function userSlug(userId: string, firstName: string): string {
  const name = firstName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user'
  const suffix = userId.replace(/-/g, '').slice(-6)
  return `${name}_${suffix}`
}

/** Absolute path to a user's root folder. Created lazily if it doesn't exist. */
export async function userDir(userId: string, firstName: string): Promise<string> {
  const root = await getDataRoot()
  const dir = join(root, userSlug(userId, firstName))
  await mkdir(dir, { recursive: true })
  return dir
}

/** Absolute path for a file/directory in a user's content category.
 *  Creates intermediate directories lazily. */
export async function userPath(
  userId: string,
  firstName: string,
  category: UserCategory,
  ...parts: string[]
): Promise<string> {
  const base = await userDir(userId, firstName)
  const dir = join(base, category)
  await mkdir(dir, { recursive: true })
  if (!parts.length) return dir
  // `parts` may include subdirectories (e.g. covers/<id>.png, stingers/<id>.wav) —
  // only the category dir was created above, so create the final file's parent too,
  // or writeFile fails with ENOENT. Every caller that passes parts ends them with a
  // filename, so the parent is everything up to the last segment.
  const full = containedJoin(dir, ...parts)
  await mkdir(dirname(full), { recursive: true })
  return full
}

// ── Relative path storage helpers ─────────────────────────────────────────────

/** Convert an absolute path to a path relative to the data root for DB storage.
 *  If the path is already relative, returns it unchanged. */
export async function toRelativePath(absPath: string): Promise<string> {
  if (!isAbsolute(absPath)) return absPath
  const root = await getDataRoot()
  return relative(root, absPath)
}

/** Resolve a relative (DB-stored) path back to absolute using the current root.
 *  Passes through paths that are already absolute (back-compat for old rows). */
export async function resolveUserPath(storedPath: string): Promise<string> {
  if (isAbsolute(storedPath)) return storedPath
  const root = await getDataRoot()
  // Relative rows are server-written, but assert containment so an attacker-influenced
  // stored path (e.g. a `..`-bearing videoId that reached path construction) can't escape.
  return containedJoin(root, storedPath)
}
