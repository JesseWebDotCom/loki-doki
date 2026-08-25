// Polls the Plex Media Server for active sessions and maps them to hub userIds
// via the stored plex_username mapping. Updates the per-user PlexActivity store
// (nowPlaying.ts) so screen Pods in 'activity' mode can show the poster + progress.
//
// The poller runs on a 30-second tick. It is intentionally lightweight: one HTTP call
// to /status/sessions, a Map lookup for username → userId, and in-memory writes.
// No DB writes per poll — only the one-time plex_username fetch/store is DB-backed.
//
// Lifecycle: startPlexNowWatchingPoller() is called once from startPodScheduler().

import { sessions } from './index'
import { getUserPlexConnection, listLinkedPlexUsers, setUserPlexUsername } from './account'
import { setPlexActivity, clearPlexActivity } from '@/lib/pod/nowPlaying'
import { logger } from '@/lib/logger'

const POLL_MS = 30_000

// In-memory username → hub userId map, warm-loaded once at start and refreshed
// whenever a linked user is encountered without a stored username.
const usernameMap = new Map<string, string>() // plexUsername.toLowerCase() → userId

/** Fetch and cache the Plex account title for a user (one plex.tv call per user). */
async function fetchAndCachePlexUsername(userId: string): Promise<string | null> {
  try {
    const conn = await getUserPlexConnection(userId)
    if (!conn) return null
    // GET /myplex/account returns the signed-in account (same URL as in auth.ts).
    const r = await fetch(`${conn.baseUrl}/myplex/account`, {
      headers: { 'X-Plex-Token': conn.token, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) return null
    const data = await r.json() as { MyPlex?: { username?: string } } | { username?: string }
    // PMS /myplex/account wraps the user in MyPlex or sometimes returns it at top level.
    const username = ('MyPlex' in data ? data.MyPlex?.username : (data as { username?: string }).username) ?? null
    if (!username) return null
    await setUserPlexUsername(userId, username)
    usernameMap.set(username.toLowerCase(), userId)
    return username
  } catch (e) {
    logger.warn(`[plex-now-watching] failed to fetch username for user ${userId}: ${e}`)
    return null
  }
}

/** Warm the username map from DB (call once at startup). */
async function warmUsernameMap(): Promise<void> {
  try {
    const linked = await listLinkedPlexUsers()
    for (const { userId, plexUsername } of linked) {
      if (plexUsername) {
        usernameMap.set(plexUsername.toLowerCase(), userId)
      } else {
        // Username not cached yet — fetch it in the background.
        void fetchAndCachePlexUsername(userId)
      }
    }
  } catch (e) {
    logger.warn(`[plex-now-watching] warmUsernameMap failed: ${e}`)
  }
}

async function poll(): Promise<void> {
  try {
    // Use the global admin connection to read all sessions (the token doesn't affect which
    // sessions appear — PMS returns all active sessions regardless of the token used).
    const { getPlexConnection } = await import('./index')
    const conn = await getPlexConnection()
    if (!conn) return

    const activeSessions = await sessions(conn)

    // Track which users have an active session so we can clear inactive ones.
    const activeUserIds = new Set<string>()

    for (const session of activeSessions) {
      if (!session.user) continue
      let userId = usernameMap.get(session.user.toLowerCase())
      if (!userId) {
        // Unknown username — might be a linked user whose username we haven't cached yet.
        // Don't fetch inline (too slow per poll); the next warmUsernameMap refresh will catch it.
        continue
      }
      activeUserIds.add(userId)
      setPlexActivity(userId, {
        title: session.title,
        showTitle: session.showTitle,
        type: session.type,
        thumb: session.thumb,
        progress: session.progress,
        state: session.state,
      })
    }

    // Clear stale Plex activity for users who are no longer in an active session.
    // The TTL in getPlexActivity will also handle this, but explicit clear is cleaner.
    for (const [, userId] of usernameMap) {
      if (!activeUserIds.has(userId)) {
        clearPlexActivity(userId)
      }
    }
  } catch (e) {
    logger.warn(`[plex-now-watching] poll error: ${e}`)
  }
}

let started = false

export async function startPlexNowWatchingPoller(): Promise<void> {
  if (started) return
  started = true
  await warmUsernameMap()
  // Poll immediately, then on interval.
  void poll()
  setInterval(() => void poll(), POLL_MS).unref?.()
}
