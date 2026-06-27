// Persist the SHARED Plex server connection (base_url + admin token) into the tool-config
// table (toolId 'plex'), the same store getPlexConnection() reads. Per-user account tokens
// live in toolUserConfig and are managed in account.ts — not here.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'
import { listUsersWithPlexStatus } from './account'

async function setKey(key: string, value: unknown): Promise<void> {
  const now = new Date()
  const [existing] = await db
    .select({ id: toolGlobalConfig.id })
    .from(toolGlobalConfig)
    .where(and(eq(toolGlobalConfig.toolId, 'plex'), eq(toolGlobalConfig.key, key)))
    .limit(1)
  if (existing) {
    await db.update(toolGlobalConfig).set({ value: JSON.stringify(value), updatedAt: now }).where(eq(toolGlobalConfig.id, existing.id))
  } else {
    await db.insert(toolGlobalConfig).values({ id: crypto.randomUUID(), toolId: 'plex', key, value: JSON.stringify(value), updatedAt: now })
  }
}

export async function savePlexConfig(patch: { baseUrl?: string; token?: string }): Promise<void> {
  if (patch.baseUrl !== undefined) await setKey('base_url', patch.baseUrl.trim().replace(/\/+$/, ''))
  if (patch.token !== undefined) await setKey('token', patch.token.trim())
}

export interface PlexConfigSummary {
  baseUrl: string
  hasToken: boolean
  users: Array<{ id: string; name: string; linked: boolean }>
}

/** Admin view of the shared server config (token never returned) + who's linked their account. */
export async function getPlexConfigSummary(): Promise<PlexConfigSummary> {
  const rows = await db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, 'plex'))
  let baseUrl = ''
  let hasToken = false
  for (const r of rows) {
    try {
      if (r.key === 'base_url') baseUrl = String(JSON.parse(r.value) ?? '')
      if (r.key === 'token') hasToken = !!String(JSON.parse(r.value) ?? '').trim()
    } catch {
      /* ignore malformed */
    }
  }
  return { baseUrl, hasToken, users: await listUsersWithPlexStatus() }
}
