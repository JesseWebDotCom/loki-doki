import { db } from '@/db'
import { streamDeckPages, streamDeckButtons } from '@/db/schema'
import { eq, asc, inArray } from 'drizzle-orm'
import { streamDeckConfig } from '@/lib/pod/wyoming'
import { podsForUser } from '@/lib/pod/registry'

export async function pushStreamDeckConfig(userId: string): Promise<void> {
  const pages = await db.select().from(streamDeckPages)
    .where(eq(streamDeckPages.userId, userId))
    .orderBy(asc(streamDeckPages.sortOrder))

  const allButtons = pages.length
    ? await db.select().from(streamDeckButtons)
        .where(inArray(streamDeckButtons.pageId, pages.map(p => p.id)))
    : []

  const payload = {
    pages: pages.map(p => ({
      id: p.id,
      name: p.name,
      gridRows: p.gridRows,
      gridCols: p.gridCols,
      sortOrder: p.sortOrder,
      buttons: allButtons
        .filter(b => b.pageId === p.id)
        .map(b => ({
          id: b.id,
          row: b.row,
          col: b.col,
          icon: b.icon,
          label: b.label,
          bgColor: b.bgColor,
          textColor: b.textColor,
          action: (() => { try { return JSON.parse(b.action) } catch { return {} } })(),
        })),
    })),
  }

  const pods = podsForUser(userId)
  for (const pod of pods) {
    pod.applyStreamDeckConfig(payload)
  }
}
