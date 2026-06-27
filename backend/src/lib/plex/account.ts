// Per-user Plex linking. The Plex Media Server is shared (one global base_url, set by the
// admin), but each app user links their OWN Plex account (their own token) so their Watchlist
// and watched-state are personal. A user's connection = the global server URL + their own token
// (falling back to the global/admin token only for read-only library browsing when unlinked).

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig, toolUserConfig, users } from '@/db/schema'
import type { PlexConnection } from './index'

async function globalPlexCfg(): Promise<{ baseUrl: string; token: string }> {
  const rows = await db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, 'plex'))
  const out = { baseUrl: '', token: '' }
  for (const r of rows) {
    try {
      const v = String(JSON.parse(r.value) ?? '')
      if (r.key === 'base_url') out.baseUrl = v
      if (r.key === 'token') out.token = v
    } catch {
      /* ignore malformed */
    }
  }
  return out
}

async function userPlexToken(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: toolUserConfig.value })
    .from(toolUserConfig)
    .where(and(eq(toolUserConfig.userId, userId), eq(toolUserConfig.toolId, 'plex'), eq(toolUserConfig.key, 'token')))
    .limit(1)
  if (!row) return null
  try {
    const v = String(JSON.parse(row.value) ?? '').trim()
    return v || null
  } catch {
    return null
  }
}

/** Resolve a connection for a specific user: shared server URL + their token (else global). */
export async function getUserPlexConnection(userId: string): Promise<PlexConnection | null> {
  const [g, userToken] = await Promise.all([globalPlexCfg(), userPlexToken(userId)])
  const baseUrl = g.baseUrl.trim().replace(/\/+$/, '')
  const token = (userToken ?? g.token).trim()
  if (!baseUrl || !token) return null
  return { baseUrl, token }
}

/** True when the user has linked their OWN Plex account (a personal token, not the fallback). */
export async function isUserPlexLinked(userId: string): Promise<boolean> {
  return (await userPlexToken(userId)) !== null
}

/** True when an admin has configured the shared server URL (so users can link to it). */
export async function isPlexServerConfigured(): Promise<boolean> {
  return !!(await globalPlexCfg()).baseUrl.trim()
}

/** All user ids that have linked a personal Plex account — the set the sync loop walks. */
export async function listLinkedPlexUserIds(): Promise<string[]> {
  const rows = await db
    .select({ userId: toolUserConfig.userId })
    .from(toolUserConfig)
    .where(and(eq(toolUserConfig.toolId, 'plex'), eq(toolUserConfig.key, 'token')))
  return [...new Set(rows.map((r) => r.userId))]
}

/** Link (token) or unlink (null) a user's personal Plex account token. */
export async function setUserPlexToken(userId: string, token: string | null): Promise<void> {
  if (!token) {
    await db.delete(toolUserConfig).where(and(eq(toolUserConfig.userId, userId), eq(toolUserConfig.toolId, 'plex'), eq(toolUserConfig.key, 'token')))
    return
  }
  const now = new Date()
  const [existing] = await db
    .select({ id: toolUserConfig.id })
    .from(toolUserConfig)
    .where(and(eq(toolUserConfig.userId, userId), eq(toolUserConfig.toolId, 'plex'), eq(toolUserConfig.key, 'token')))
    .limit(1)
  if (existing) {
    await db.update(toolUserConfig).set({ value: JSON.stringify(token), updatedAt: now }).where(eq(toolUserConfig.id, existing.id))
  } else {
    await db.insert(toolUserConfig).values({ id: crypto.randomUUID(), userId, toolId: 'plex', key: 'token', value: JSON.stringify(token), updatedAt: now })
  }
}

/** Admin view: every user with their linked status + display name. */
export async function listUsersWithPlexStatus(): Promise<Array<{ id: string; name: string; linked: boolean }>> {
  const [userRows, linked] = await Promise.all([
    db.select({ id: users.id, firstName: users.firstName, nickname: users.nickname }).from(users),
    listLinkedPlexUserIds(),
  ])
  const set = new Set(linked)
  return userRows.map((u) => ({ id: u.id, name: u.nickname || u.firstName, linked: set.has(u.id) }))
}
