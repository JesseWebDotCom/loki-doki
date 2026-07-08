// Studio → Plex ("mine" library) fan-out. A studio video that just went ready — or just
// got shared/unshared — needs placement jobs for every household member whose My Videos
// library should (or should no longer) contain it. Placement itself no-ops for users
// without a ready 'mine' section, so this only pre-filters for the share fan-out where
// enumerating every user would enqueue pointless jobs.

import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/db'
import { studioMedia, plexLibrarySections } from '@/db/schema'

/** Users other than `ownerId` with a ready My Videos library. */
async function otherMineLibraryUserIds(ownerId: string): Promise<string[]> {
  const rows = await db.select({ userId: plexLibrarySections.userId }).from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.contentType, 'mine'), eq(plexLibrarySections.status, 'ready'), ne(plexLibrarySections.userId, ownerId)))
  return rows.map(r => r.userId)
}

/** Call after a studio_media video flips ready: place into the owner's library, plus every
 *  other member's if it's shared. Non-video kinds are ignored. */
export async function enqueueMinePlacement(mediaId: string): Promise<void> {
  const [row] = await db.select().from(studioMedia).where(eq(studioMedia.id, mediaId)).limit(1)
  if (!row || row.kind !== 'video' || row.status !== 'ready') return
  const { enqueuePlexSync } = await import('@/lib/downloadJobs')
  await enqueuePlexSync(row.userId, mediaId, 'add', 'mine').catch(() => {})
  if (row.sharedAt) {
    for (const userId of await otherMineLibraryUserIds(row.userId)) {
      await enqueuePlexSync(userId, mediaId, 'add', 'mine').catch(() => {})
    }
  }
}

/** Call when the share flag changes: adds to (or removes from) every OTHER member's
 *  library — the owner's own placement is unaffected by sharing. */
export async function fanOutShareChange(mediaId: string, shared: boolean): Promise<void> {
  const [row] = await db.select().from(studioMedia).where(eq(studioMedia.id, mediaId)).limit(1)
  if (!row || row.kind !== 'video') return
  const { enqueuePlexSync } = await import('@/lib/downloadJobs')
  for (const userId of await otherMineLibraryUserIds(row.userId)) {
    await enqueuePlexSync(userId, mediaId, shared ? 'add' : 'remove', 'mine').catch(() => {})
  }
}

/** Call before a studio video is deleted: pull it from every library it was placed in. */
export async function fanOutMineRemoval(mediaId: string, ownerId: string): Promise<void> {
  const { enqueuePlexSync } = await import('@/lib/downloadJobs')
  await enqueuePlexSync(ownerId, mediaId, 'remove', 'mine').catch(() => {})
  for (const userId of await otherMineLibraryUserIds(ownerId)) {
    await enqueuePlexSync(userId, mediaId, 'remove', 'mine').catch(() => {})
  }
}
