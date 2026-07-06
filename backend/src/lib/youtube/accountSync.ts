// Account sync — keeps the local YouTube library mirroring the user's linked Google
// account, with Google as the source of truth. Pull: subscriptions, Watch Later and Liked
// are reconciled into yt_subscriptions / yt_collections as source='google' rows on a slow
// poll (and immediately after linking). Push: in-app subscribe / watch-later / like
// actions are replayed to the account fire-and-forget, so the next pull confirms rather
// than conflicts. Rows the user created before linking (source='local') are never deleted
// by sync — only rows this module wrote are ever reclaimed.

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytAccounts, ytSubscriptions, ytCollections } from '@/db/schema'
import { getAccountRow, getValidAccessToken } from '@/lib/youtube/account'
import {
  fetchSubscribedChannels, fetchAccountPlaylist,
  tvSubscribe, tvUnsubscribe, tvPlaylistAdd, tvPlaylistRemove, tvLike, tvRemoveLike,
  TvAuthError,
} from '@/lib/youtube/tvClient'
import { refreshUserFeeds } from '@/lib/youtube/feed'
import { logger } from '@/lib/logger'

const SYNC_INTERVAL_MS = 30 * 60 * 1000
// Liked can run to thousands; mirror only the most recent slice — it's a browsing
// collection here, not an archive.
const LIKED_CAP = 200

// Run an authed TV call, force-refreshing the token and retrying once on a mid-call 401
// (Google occasionally invalidates access tokens before their nominal expiry).
async function withToken<T>(userId: string, fn: (token: string) => Promise<T>): Promise<T | null> {
  const token = await getValidAccessToken(userId)
  if (!token) return null
  try {
    return await fn(token)
  } catch (err) {
    if (!(err instanceof TvAuthError)) throw err
    const fresh = await getValidAccessToken(userId, true)
    if (!fresh) return null
    return fn(fresh)
  }
}

// ── Pull ───────────────────────────────────────────────────────────────────────

export async function syncAccount(userId: string): Promise<void> {
  const account = await getAccountRow(userId)
  if (!account || account.status !== 'active') return

  const errors: string[] = []
  if (account.syncSubscriptions) {
    try { await pullSubscriptions(userId) } catch (err) { errors.push(`subscriptions: ${err instanceof Error ? err.message : err}`) }
  }
  if (account.syncWatchLater) {
    try { await pullCollection(userId, 'watch-later', 'WL', 1000) } catch (err) { errors.push(`watch later: ${err instanceof Error ? err.message : err}`) }
  }
  if (account.syncLiked) {
    try { await pullCollection(userId, 'liked', 'LL', LIKED_CAP) } catch (err) { errors.push(`liked: ${err instanceof Error ? err.message : err}`) }
  }

  await db.update(ytAccounts).set({
    lastSyncAt: new Date(),
    lastSyncError: errors.length ? errors.join(' · ') : null,
  }).where(eq(ytAccounts.userId, userId))
  if (errors.length) logger.warn({ userId, errors }, '[yt-account-sync] sync completed with errors')
}

async function pullSubscriptions(userId: string): Promise<void> {
  const channels = await withToken(userId, fetchSubscribedChannels)
  if (channels == null) throw new Error('account not linked or expired')
  // An empty list is far more likely a parse miss (TV response shape drifted) than an
  // account subscribed to nothing — never treat it as "delete everything".
  if (!channels.length) {
    logger.warn({ userId }, '[yt-account-sync] channel list came back empty — skipping reconcile')
    return
  }

  const existing = await db.select({
    id: ytSubscriptions.id, externalId: ytSubscriptions.externalId, source: ytSubscriptions.source,
    title: ytSubscriptions.title, thumbnailUrl: ytSubscriptions.thumbnailUrl,
  }).from(ytSubscriptions)
    .where(and(eq(ytSubscriptions.userId, userId), eq(ytSubscriptions.kind, 'channel')))
  const byExt = new Map(existing.map(e => [e.externalId, e]))
  const googleIds = new Set(channels.map(ch => ch.channelId))

  const now = new Date()
  let added = 0
  for (const ch of channels) {
    const row = byExt.get(ch.channelId)
    if (row) {
      // Adopt pre-existing local rows (they're the same subscription now) and freshen
      // whatever display fields the TV response actually carried.
      const patch: Record<string, unknown> = {}
      if (row.source !== 'google') patch.source = 'google'
      if (ch.title && ch.title !== row.title) patch.title = ch.title
      if (ch.thumbnailUrl && ch.thumbnailUrl !== row.thumbnailUrl) patch.thumbnailUrl = ch.thumbnailUrl
      if (Object.keys(patch).length) await db.update(ytSubscriptions).set(patch).where(eq(ytSubscriptions.id, row.id))
      continue
    }
    await db.insert(ytSubscriptions).values({
      id: crypto.randomUUID(),
      userId,
      kind: 'channel',
      externalId: ch.channelId,
      title: ch.title,
      handle: ch.handle,
      thumbnailUrl: ch.thumbnailUrl,
      source: 'google',
      addedAt: now,
    }).onConflictDoNothing()
    added++
  }

  // Unsubscribed on YouTube → gone here. Only rows sync owns.
  const removed = existing.filter(e => e.source === 'google' && !googleIds.has(e.externalId))
  if (removed.length) {
    await db.delete(ytSubscriptions).where(inArray(ytSubscriptions.id, removed.map(r => r.id)))
  }

  if (added) void refreshUserFeeds(userId).catch(() => {})
  logger.info({ userId, total: channels.length, added, removed: removed.length }, '[yt-account-sync] subscriptions reconciled')
}

async function pullCollection(userId: string, key: 'watch-later' | 'liked', playlistId: 'WL' | 'LL', cap: number): Promise<void> {
  const items = await withToken(userId, token => fetchAccountPlaylist(token, playlistId, cap))
  if (items == null) throw new Error('account not linked or expired')
  if (!items.length) {
    // Empty is ambiguous (empty playlist vs. parse miss) — adding nothing is safe either
    // way, deleting is only safe in one of them. Leave existing rows alone.
    return
  }

  const existing = await db.select({
    id: ytCollections.id, videoId: ytCollections.videoId, source: ytCollections.source,
  }).from(ytCollections)
    .where(and(eq(ytCollections.userId, userId), eq(ytCollections.collection, key)))
  const byVid = new Map(existing.map(e => [e.videoId, e]))
  const googleIds = new Set(items.map(v => v.videoId))

  // Playlist order is most-recently-added first; stagger addedAt so our newest-first
  // ordering reproduces it for rows we've never seen before.
  const base = Date.now()
  let added = 0
  for (let i = 0; i < items.length; i++) {
    const v = items[i]
    if (!v) continue
    const row = byVid.get(v.videoId)
    if (row) {
      if (row.source !== 'google') await db.update(ytCollections).set({ source: 'google' }).where(eq(ytCollections.id, row.id))
      continue
    }
    await db.insert(ytCollections).values({
      id: crypto.randomUUID(),
      userId,
      collection: key,
      videoId: v.videoId,
      title: v.title,
      author: v.author,
      channelId: v.channelId,
      durationSec: v.durationSec,
      source: 'google',
      addedAt: new Date(base - i * 1000),
    }).onConflictDoNothing()
    added++
  }

  const removed = existing.filter(e => e.source === 'google' && !googleIds.has(e.videoId))
  if (removed.length) {
    await db.delete(ytCollections).where(inArray(ytCollections.id, removed.map(r => r.id)))
  }
  logger.info({ userId, key, total: items.length, added, removed: removed.length }, '[yt-account-sync] collection reconciled')
}

// ── Push ───────────────────────────────────────────────────────────────────────
// Best-effort by design: the local write already happened and must not be blocked or
// rolled back by YouTube being unreachable — the periodic pull re-converges either way.

async function push(userId: string, label: string, op: (token: string) => Promise<void>): Promise<void> {
  try {
    const account = await getAccountRow(userId)
    if (!account || account.status !== 'active' || !account.pushEnabled) return
    await withToken(userId, op)
  } catch (err) {
    logger.warn({ userId, label, err: String(err) }, '[yt-account-sync] push failed')
  }
}

export function pushSubscribe(userId: string, channelId: string): void {
  void push(userId, `subscribe ${channelId}`, token => tvSubscribe(token, channelId))
}

export function pushUnsubscribe(userId: string, channelId: string): void {
  void push(userId, `unsubscribe ${channelId}`, token => tvUnsubscribe(token, channelId))
}

export function pushCollectionChange(userId: string, key: 'watch-later' | 'liked', videoId: string, op: 'add' | 'remove'): void {
  const label = `${key} ${op} ${videoId}`
  if (key === 'watch-later') {
    void push(userId, label, token => (op === 'add' ? tvPlaylistAdd(token, 'WL', videoId) : tvPlaylistRemove(token, 'WL', videoId)))
  } else {
    void push(userId, label, token => (op === 'add' ? tvLike(token, videoId) : tvRemoveLike(token, videoId)))
  }
}

// ── Background poll ────────────────────────────────────────────────────────────

let _syncTimer: ReturnType<typeof setInterval> | null = null
let _syncing = false

async function syncAllAccounts(): Promise<void> {
  if (_syncing) return
  _syncing = true
  try {
    const accounts = await db.select({ userId: ytAccounts.userId }).from(ytAccounts)
      .where(eq(ytAccounts.status, 'active'))
    for (const a of accounts) {
      await syncAccount(a.userId).catch(err =>
        logger.warn({ userId: a.userId, err: String(err) }, '[yt-account-sync] account sync failed'))
    }
  } finally {
    _syncing = false
  }
}

export function startYoutubeAccountSync(): void {
  if (_syncTimer) return
  // First pass shortly after boot (staggered off the feed poller), then every interval.
  const kickoff = setTimeout(() => { void syncAllAccounts() }, 45_000)
  kickoff.unref?.()
  _syncTimer = setInterval(() => { void syncAllAccounts() }, SYNC_INTERVAL_MS)
  _syncTimer.unref?.()
}
