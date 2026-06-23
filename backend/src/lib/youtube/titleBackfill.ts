// One-time backfill: decode HTML/XML entities in titles that were stored before
// the ingestion-side decode existed (e.g. "Foo &amp; Bar" → "Foo & Bar"). Runs once
// at boot, guarded by an app-setting flag. Decoding is idempotent (a title with no
// entities is unchanged), so this is safe even if it somehow runs twice.

import { like } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { ytVideos, ytSubscriptions, ytDownloads } from '@/db/schema'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { decodeEntities } from '@/lib/htmlText'
import { logger } from '@/lib/logger'

const FLAG = 'yt.titles_decoded_v1'

export async function backfillYoutubeTitleEntities(): Promise<void> {
  if ((await getAppSetting(FLAG)) === true) return

  let fixed = 0
  const tables = [
    { name: 'yt_videos', id: ytVideos.id, title: ytVideos.title, table: ytVideos },
    { name: 'yt_subscriptions', id: ytSubscriptions.id, title: ytSubscriptions.title, table: ytSubscriptions },
    { name: 'yt_downloads', id: ytDownloads.id, title: ytDownloads.title, table: ytDownloads },
  ] as const

  for (const t of tables) {
    // Only rows that contain an ampersand can hold an entity.
    const rows = await db.select({ id: t.id, title: t.title }).from(t.table).where(like(t.title, '%&%'))
    for (const r of rows) {
      const decoded = decodeEntities(r.title)
      if (decoded !== r.title) {
        await db.update(t.table).set({ title: decoded }).where(eq(t.id, r.id))
        fixed++
      }
    }
  }

  await setAppSetting(FLAG, true)
  if (fixed > 0) logger.info(`[youtube] decoded entities in ${fixed} stored title(s)`)
}
