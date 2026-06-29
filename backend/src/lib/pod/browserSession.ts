import { logger } from '@/lib/logger'

export interface BrowserCommand {
  type: 'navigate' | 'open_url' | 'app_action' | 'stream_deck_page_jump'
  path?: string
  url?: string
  action?: string
  payload?: Record<string, unknown>
  pageId?: string
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

/** Push a command to all active browser sessions for this user. */
export function pushToBrowserSession(userId: string, cmd: BrowserCommand): void {
  const set = sessions.get(userId)
  if (!set || set.size === 0) {
    logger.info(`[browser-session] no active sessions for userId=${userId}`)
    return
  }
  for (const send of set) {
    try { send(cmd) } catch { /* tab closed mid-push */ }
  }
}
