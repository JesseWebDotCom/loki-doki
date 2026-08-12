import { Hono } from 'hono'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, sqlite } from '@/db'
import { users, characters, memories, entities, memoryEpisodes, memoryProfiles, conversations, messages, chatDocuments } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { invalidateAllMemoryBlocks } from '@/memory/blockCache'
import { invalidateAllEntityCaches } from '@/memory/recall'
import { clearProfileCache } from '@/memory/profile'
import { clearMoodCache } from '@/memory/mood'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

const adminMemory = new Hono<AppEnv>()

// ── POST /api/admin/memory/reset-all ──────────────────────────────────────────
// The "reset all companion data" button: erases EVERY conversation, message,
// attached chat document, memory, entity, episode, knowledge paragraph, and mood
// for EVERY user and companion, then drops all in-process caches so the running
// server forgets too. Accounts, settings, media, notes, and integrations are
// untouched. Deliberately total: partial per-user clears live on the routes below.

adminMemory.post('/reset-all', requireAdmin, async (c) => {
  const user = c.get('user')
  const counts: Record<string, number> = {}
  // Order matters only for readability — SQLite cascades handle FK cleanup.
  counts['messages'] = (await db.delete(messages).returning({ id: messages.id })).length
  counts['conversations'] = (await db.delete(conversations).returning({ id: conversations.id })).length
  counts['chatDocuments'] = (await db.delete(chatDocuments).returning({ id: chatDocuments.id })).length
  counts['memories'] = (await db.delete(memories).returning({ id: memories.id })).length
  counts['entities'] = (await db.delete(entities).returning({ id: entities.id })).length
  counts['episodes'] = (await db.delete(memoryEpisodes).returning({ id: memoryEpisodes.id })).length
  counts['profiles'] = (await db.delete(memoryProfiles).returning({ id: memoryProfiles.id })).length
  try { counts['moods'] = sqlite.query('DELETE FROM user_moods').run().changes } catch { counts['moods'] = 0 }

  invalidateAllMemoryBlocks()
  invalidateAllEntityCaches()
  clearProfileCache()
  clearMoodCache()

  logger.warn(`[admin:memory] RESET ALL companion data by admin ${user.id}: ${JSON.stringify(counts)}`)
  return c.json({ ok: true, counts })
})

// ── GET /api/admin/memory ─────────────────────────────────────────────────────
// All users with aggregate memory counts. Used to populate the user list.

adminMemory.get('/', requireAdmin, async (c) => {
  const allUsers = await db
    .select({ id: users.id, firstName: users.firstName, nickname: users.nickname, avatarUrl: users.avatarUrl })
    .from(users)

  // Three GROUP BY aggregates instead of 3 COUNT queries per user (was an N+1).
  const [memRows, entityRows, episodeRows] = await Promise.all([
    db
      .select({ userId: memories.userId, count: sql<number>`count(*)` })
      .from(memories)
      .where(eq(memories.status, 'active'))
      .groupBy(memories.userId),
    db
      .select({ userId: entities.userId, count: sql<number>`count(*)` })
      .from(entities)
      .groupBy(entities.userId),
    db
      .select({ userId: memoryEpisodes.userId, count: sql<number>`count(*)` })
      .from(memoryEpisodes)
      .groupBy(memoryEpisodes.userId),
  ])

  const memByUser = new Map<string, number>()
  for (const r of memRows) { if (r.userId) memByUser.set(r.userId, r.count) }
  const entityByUser = new Map<string, number>()
  for (const r of entityRows) { if (r.userId) entityByUser.set(r.userId, r.count) }
  const episodeByUser = new Map<string, number>()
  for (const r of episodeRows) { if (r.userId) episodeByUser.set(r.userId, r.count) }

  const result = allUsers.map((u) => ({
    ...u,
    memories: memByUser.get(u.id) ?? 0,
    entities: entityByUser.get(u.id) ?? 0,
    episodes: episodeByUser.get(u.id) ?? 0,
  }))

  return c.json(result)
})

// ── GET /api/admin/memory/:userId ─────────────────────────────────────────────
// Full memory detail for one user, grouped by scope.

adminMemory.get('/:userId', requireAdmin, async (c) => {
  const userId = c.req.param('userId')

  const [user] = await db
    .select({ id: users.id, firstName: users.firstName, nickname: users.nickname })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) return c.json({ error: 'Not found' }, 404)

  // All memories for this user (all scopes, all statuses)
  const allMemories = await db
    .select()
    .from(memories)
    .where(eq(memories.userId, userId))

  // All entities for this user
  const allEntities = await db
    .select()
    .from(entities)
    .where(eq(entities.userId, userId))

  // All episodes for this user
  const allEpisodes = await db
    .select({
      id: memoryEpisodes.id,
      characterId: memoryEpisodes.characterId,
      summary: memoryEpisodes.summary,
      messageCount: memoryEpisodes.messageCount,
      createdAt: memoryEpisodes.createdAt,
    })
    .from(memoryEpisodes)
    .where(eq(memoryEpisodes.userId, userId))

  // Collect distinct character ids referenced
  const charIds = new Set<string>()
  for (const m of allMemories) { if (m.characterId) charIds.add(m.characterId) }
  for (const e of allEntities) { if (e.characterId) charIds.add(e.characterId) }
  for (const ep of allEpisodes) { if (ep.characterId) charIds.add(ep.characterId) }

  // Load character names
  const charNameMap = new Map<string, string>()
  if (charIds.size > 0) {
    const charRows = await db.select({ id: characters.id, name: characters.name }).from(characters)
    for (const ch of charRows) charNameMap.set(ch.id, ch.name)
  }

  // Group into scopes: null = user-global, then one per character
  const scopeMap = new Map<string | null, {
    characterId: string | null
    characterName: string | null
    memories: typeof allMemories
    entities: typeof allEntities
    episodes: typeof allEpisodes
  }>()

  const getOrCreateScope = (characterId: string | null) => {
    const key = characterId ?? '__global__'
    if (!scopeMap.has(key)) {
      scopeMap.set(key, {
        characterId,
        characterName: characterId ? (charNameMap.get(characterId) ?? characterId) : null,
        memories: [],
        entities: [],
        episodes: [],
      })
    }
    return scopeMap.get(key)!
  }

  for (const m of allMemories) getOrCreateScope(m.characterId ?? null).memories.push(m)
  for (const e of allEntities) getOrCreateScope(e.characterId ?? null).entities.push(e)
  for (const ep of allEpisodes) getOrCreateScope(ep.characterId ?? null).episodes.push(ep)

  // User-global first, then characters sorted by name
  const scopes = [...scopeMap.values()].sort((a, b) => {
    if (!a.characterId) return -1
    if (!b.characterId) return 1
    return (a.characterName ?? '').localeCompare(b.characterName ?? '')
  })

  return c.json({ user, scopes })
})

// ── DELETE /api/admin/memory/:userId ─────────────────────────────────────────
// Clear ALL memories, entities, and episodes for a user (all scopes).

adminMemory.delete('/:userId', requireAdmin, async (c) => {
  const userId = c.req.param('userId')

  await db.delete(memories).where(eq(memories.userId, userId))
  await db.delete(entities).where(eq(entities.userId, userId))
  await db.delete(memoryEpisodes).where(eq(memoryEpisodes.userId, userId))

  return c.json({ ok: true })
})

// ── DELETE /api/admin/memory/:userId/scope ────────────────────────────────────
// Clear one scope: user-global (character_id=null) or a specific character.
// Body: { characterId: string | null }

adminMemory.delete('/:userId/scope', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const { characterId } = (await c.req.json()) as { characterId: string | null }

  const memWhere = characterId
    ? and(eq(memories.userId, userId), eq(memories.characterId, characterId))
    : and(eq(memories.userId, userId), isNull(memories.characterId))

  const entWhere = characterId
    ? and(eq(entities.userId, userId), eq(entities.characterId, characterId))
    : and(eq(entities.userId, userId), isNull(entities.characterId))

  const epWhere = characterId
    ? and(eq(memoryEpisodes.userId, userId), eq(memoryEpisodes.characterId, characterId))
    : and(eq(memoryEpisodes.userId, userId), isNull(memoryEpisodes.characterId))

  await db.delete(memories).where(memWhere)
  await db.delete(entities).where(entWhere)
  await db.delete(memoryEpisodes).where(epWhere)

  return c.json({ ok: true })
})

// ── DELETE /api/admin/memory/:userId/memory/:memoryId ────────────────────────
// Delete a single memory row.

adminMemory.delete('/:userId/memory/:memoryId', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const memoryId = c.req.param('memoryId')

  await db
    .delete(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))

  return c.json({ ok: true })
})

export { adminMemory }
