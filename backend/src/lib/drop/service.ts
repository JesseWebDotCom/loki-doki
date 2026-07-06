// Drop storage lifecycle: where file bytes live, and the sweep that expires stale
// drops. Bytes are kept out of the content-dedup blob store on purpose — drops are
// ephemeral and single-recipient, so dedup buys nothing and the GC coupling would be
// a liability. Instead each file lives at data/drops/<id> and this module owns its
// deletion (on claim, and on TTL expiry).

import { join } from 'node:path'
import { mkdir, unlink, readdir } from 'node:fs/promises'
import { lt, or, and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { fileDrops } from '@/db/schema'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'
import type { DropEvent } from '@/lib/drop/presence'

export const DROPS_DIR = join(dataDir, 'drops')

/** Default time a pending drop lives before it's swept. */
export const DROP_TTL_MS = 24 * 60 * 60 * 1000
/** Grace period to keep a file after it's claimed (lets a re-download succeed). */
const CLAIMED_GRACE_MS = 5 * 60 * 1000

export async function ensureDropsDir(): Promise<void> {
  await mkdir(DROPS_DIR, { recursive: true })
}

export function dropFilePath(id: string): string {
  return join(DROPS_DIR, id)
}

type DropRow = typeof fileDrops.$inferSelect

/** Shape a DB row into the lightweight preview pushed over SSE / stored in the inbox. */
export function toPreview(row: DropRow): NonNullable<DropEvent['drop']> {
  return {
    id: row.id,
    kind: row.kind,
    fileName: row.fileName,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    body: row.body,
    senderLabel: row.senderLabel,
    createdAt: (row.createdAt as Date).getTime(),
  }
}

/** Delete a drop's row + backing file. Safe to call more than once. */
export async function purgeDrop(id: string): Promise<void> {
  await unlink(dropFilePath(id)).catch(() => {})
  await db.delete(fileDrops).where(eq(fileDrops.id, id))
}

/** Expire + delete stale drops: pending past TTL, or claimed past the grace window.
 *  Also removes orphan files with no row (belt-and-suspenders after crashes). */
async function sweepOnce(): Promise<void> {
  const now = Date.now()
  const stale = await db
    .select({ id: fileDrops.id })
    .from(fileDrops)
    .where(
      or(
        lt(fileDrops.expiresAt, new Date(now)),
        and(eq(fileDrops.status, 'claimed'), lt(fileDrops.claimedAt, new Date(now - CLAIMED_GRACE_MS))),
      ),
    )
  for (const { id } of stale) await purgeDrop(id)

  // Orphan files (row already gone) — clean the directory.
  try {
    const files = await readdir(DROPS_DIR).catch(() => [] as string[])
    if (files.length) {
      const live = new Set((await db.select({ id: fileDrops.id }).from(fileDrops)).map((r) => r.id))
      for (const f of files) if (!live.has(f)) await unlink(join(DROPS_DIR, f)).catch(() => {})
    }
  } catch { /* best-effort */ }

  if (stale.length) logger.info(`[drop] swept ${stale.length} stale drop(s)`)
}

// Guard against bun --hot double-registering the interval across reloads.
const G = globalThis as unknown as { __dropSweepStarted?: boolean }

export function startDropSweep(): void {
  if (G.__dropSweepStarted) return
  G.__dropSweepStarted = true
  void ensureDropsDir()
  void sweepOnce().catch(() => {})
  setInterval(() => void sweepOnce().catch(() => {}), 15 * 60 * 1000)
  logger.info('[drop] TTL sweep started (15m)')
}
