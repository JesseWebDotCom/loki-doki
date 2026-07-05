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

/** The user's OWN linked Plex token — unlike getUserPlexConnection(), does NOT fall back to
 *  the admin/global token. Needed wherever we must identify WHICH Plex account a user is
 *  (e.g. provisioning a private library share) rather than just get a working connection. */
export async function getUserOwnPlexToken(userId: string): Promise<string | null> {
  return userPlexToken(userId)
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

// ── Plex account username (for session attribution) ──────────────────────────────
// PMS /status/sessions only exposes a Plex display-name string (User.title), not an id.
// We persist the user's Plex account username at link time so the session poller can
// match session.user → loki userId without a live plex.tv call on every poll.

async function upsertUserPlexKey(userId: string, key: string, value: string): Promise<void> {
  const now = new Date()
  const [existing] = await db
    .select({ id: toolUserConfig.id })
    .from(toolUserConfig)
    .where(and(eq(toolUserConfig.userId, userId), eq(toolUserConfig.toolId, 'plex'), eq(toolUserConfig.key, key)))
    .limit(1)
  if (existing) {
    await db.update(toolUserConfig).set({ value: JSON.stringify(value), updatedAt: now }).where(eq(toolUserConfig.id, existing.id))
  } else {
    await db.insert(toolUserConfig).values({ id: crypto.randomUUID(), userId, toolId: 'plex', key, value: JSON.stringify(value), updatedAt: now })
  }
}

export async function setUserPlexUsername(userId: string, username: string): Promise<void> {
  await upsertUserPlexKey(userId, 'plex_username', username)
}

export async function getUserPlexUsername(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: toolUserConfig.value })
    .from(toolUserConfig)
    .where(and(eq(toolUserConfig.userId, userId), eq(toolUserConfig.toolId, 'plex'), eq(toolUserConfig.key, 'plex_username')))
    .limit(1)
  if (!row) return null
  try { return String(JSON.parse(row.value) ?? '').trim() || null } catch { return null }
}

/** All linked users along with their stored Plex username (null if not yet fetched). */
export async function listLinkedPlexUsers(): Promise<Array<{ userId: string; plexUsername: string | null }>> {
  const rows = await db
    .select({ userId: toolUserConfig.userId, key: toolUserConfig.key, value: toolUserConfig.value })
    .from(toolUserConfig)
    .where(and(eq(toolUserConfig.toolId, 'plex')))
  const byUser = new Map<string, { token: boolean; username: string | null }>()
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, { token: false, username: null })
    const entry = byUser.get(r.userId)!
    if (r.key === 'token') entry.token = true
    if (r.key === 'plex_username') { try { entry.username = String(JSON.parse(r.value) ?? '') || null } catch { /* ignore */ } }
  }
  return [...byUser.entries()].filter(([, v]) => v.token).map(([userId, v]) => ({ userId, plexUsername: v.username }))
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
