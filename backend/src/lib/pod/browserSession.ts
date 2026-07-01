import { logger } from '@/lib/logger'

export interface BrowserCommand {
  type: 'navigate' | 'open_url' | 'app_action' | 'stream_deck_page_jump' | 'media_transport'
  path?: string
  url?: string
  action?: string
  payload?: Record<string, unknown>
  pageId?: string
  // media_transport: a play/pause/next/prev/seek from the device's native player.
  transport?: 'play' | 'pause' | 'toggle' | 'next' | 'prev' | 'seek' | 'stop'
  position?: number   // seconds, for transport === 'seek'
}

// userId → Set of active SSE response writers
// Using a Set so multiple tabs get the command simultaneously
const sessions = new Map<string, Set<(cmd: BrowserCommand) => void>>()

/** Register a new browser session. Returns an unregister function. */
export function registerBrowserSession(userId: string, send: (cmd: BrowserCommand) => void): () => void {
  if (!sessions.has(userId)) sessions.set(userId, new Set())
  sessions.get(userId)!.add(send)
  logger.info(`[browser-session] registered userId=${userId} (${sessions.get(userId)!.size} tabs)`)
  return () => {
    const set = sessions.get(userId)
    if (set) {
      set.delete(send)
      if (set.size === 0) sessions.delete(userId)
    }
    logger.info(`[browser-session] unregistered userId=${userId}`)
  }
}

/** Push a command to the MOST RECENT browser session for this user (the latest tab the
 *  user opened) — not every tab, so a controller tap drives one player, not all of them.
 *  (The Set preserves insertion order, so the last entry is the most recently connected.) */
export function pushToBrowserSession(userId: string, cmd: BrowserCommand): void {
  const set = sessions.get(userId)
  if (!set || set.size === 0) {
    logger.info(`[browser-session] no active sessions for userId=${userId}`)
    return
  }
  const recent = Array.from(set).pop()
  if (recent) { try { recent(cmd) } catch { /* tab closed mid-push */ } }
}
