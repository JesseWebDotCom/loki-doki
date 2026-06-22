import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getAppSetting } from '@/lib/settings'

export type ConnectivityMode = 'online' | 'offline'

let _globalCache: { mode: ConnectivityMode; expiresAt: number } | null = null

async function getGlobalMode(): Promise<ConnectivityMode> {
  if (_globalCache && Date.now() < _globalCache.expiresAt) return _globalCache.mode
  const stored = (await getAppSetting('connectivity.global_mode')) as ConnectivityMode | null
  const mode: ConnectivityMode = stored === 'offline' ? 'offline' : 'online'
  _globalCache = { mode, expiresAt: Date.now() + 30_000 }
  return mode
}

export function invalidateGlobalModeCache(): void {
  _globalCache = null
}

export async function isGloballyOffline(): Promise<boolean> {
  return (await getGlobalMode()) === 'offline'
}

let _allowDownloadsCache: { value: boolean; expiresAt: number } | null = null

async function getAllowDownloads(): Promise<boolean> {
  if (_allowDownloadsCache && Date.now() < _allowDownloadsCache.expiresAt) return _allowDownloadsCache.value
  const stored = await getAppSetting('connectivity.allow_downloads')
  const value = stored === 'true'
  _allowDownloadsCache = { value, expiresAt: Date.now() + 30_000 }
  return value
}

export function invalidateAllowDownloadsCache(): void { _allowDownloadsCache = null }

/** True when downloads should be blocked: globally offline AND allow_downloads is not set. */
export async function isDownloadBlocked(): Promise<boolean> {
  if ((await getGlobalMode()) !== 'offline') return false
  return !(await getAllowDownloads())
}

export async function isOffline(userId: string): Promise<boolean> {
  if ((await getGlobalMode()) === 'offline') return true
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'connectivity.mode')))
    .limit(1)
  return row ? (JSON.parse(row.value) as ConnectivityMode) === 'offline' : false
}
