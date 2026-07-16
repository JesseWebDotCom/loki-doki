import { Hono } from 'hono'
import { and, eq, desc } from 'drizzle-orm'
import { db } from '@/db'
import { mediaProgress } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

// Cross-device playback position for streamed media (#14). Written on a throttled heartbeat
// by each player and read on open, so a video/episode/song resumes at the same spot on any
// device. The media sibling of book_progress.

const media = new Hono<AppEnv>()

// Most-recently-updated in-progress items (for a future "continue watching" surface).
media.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db
    .select()
    .from(mediaProgress)
    .where(eq(mediaProgress.userId, user.id))
    .orderBy(desc(mediaProgress.updatedAt))
    .limit(50)
  return c.json({ items: rows })
})

// Saved position for one asset (null if none yet).
media.get('/:assetType/:assetId', requireAuth, async (c) => {
  const user = c.get('user')
  const assetType = c.req.param('assetType')
  const assetId = c.req.param('assetId')
  const [row] = await db
    .select()
    .from(mediaProgress)
    .where(and(
      eq(mediaProgress.userId, user.id),
      eq(mediaProgress.assetType, assetType),
      eq(mediaProgress.assetId, assetId),
    ))
    .limit(1)
  return c.json({ progress: row ?? null })
})

// Upsert the position for one asset.
media.put('/:assetType/:assetId', requireAuth, async (c) => {
  const user = c.get('user')
  const assetType = c.req.param('assetType')
  const assetId = c.req.param('assetId')
  const body = await c.req.json().catch(() => ({})) as {
    positionSec?: number
    durationSec?: number | null
    completed?: boolean
  }
  const positionSec = Number.isFinite(body.positionSec) ? Math.max(0, body.positionSec as number) : 0
  const durationSec = Number.isFinite(body.durationSec as number) ? (body.durationSec as number) : null
  const now = new Date()
  await db
    .insert(mediaProgress)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      assetType,
      assetId,
      positionSec,
      durationSec,
      completed: body.completed ?? false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [mediaProgress.userId, mediaProgress.assetType, mediaProgress.assetId],
      set: { positionSec, durationSec, completed: body.completed ?? false, updatedAt: now },
    })
  return c.json({ ok: true })
})

export { media as mediaProgress }
