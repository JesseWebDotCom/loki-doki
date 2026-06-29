import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { streamDeckButtons } from '@/db/schema'
import { logger } from '@/lib/logger'
import { pushToBrowserSession } from '@/lib/pod/browserSession'

export type StreamDeckAction =
  | { type: 'none' }
  | { type: 'browser_navigate'; path: string }
  | { type: 'browser_url'; url: string }
  | { type: 'app_action'; action: string; payload?: Record<string, unknown> }
  | { type: 'page_jump'; pageId: string }
  | { type: 'webhook'; url: string; method?: string; headers?: Record<string, string>; body?: string }

/** Called from SatelliteSession when a Tab5 sends a button_press user-event. */
export async function handleButtonPress(pageId: string, row: number, col: number, userId: string): Promise<void> {
  const [button] = await db
    .select()
    .from(streamDeckButtons)
    .where(
      and(
        eq(streamDeckButtons.pageId, pageId),
        eq(streamDeckButtons.row, row),
        eq(streamDeckButtons.col, col),
      ),
    )
  if (!button) return

  let action: StreamDeckAction
  try {
    action = JSON.parse(button.action) as StreamDeckAction
  } catch {
    return
  }

  logger.info(`[stream-deck] button press page=${pageId} (${row},${col}) action=${action.type} user=${userId}`)

  switch (action.type) {
    case 'none':
      break

    case 'browser_navigate':
      pushToBrowserSession(userId, { type: 'navigate', path: action.path })
      break

    case 'browser_url':
      pushToBrowserSession(userId, { type: 'open_url', url: action.url })
      break

    case 'app_action':
      pushToBrowserSession(userId, { type: 'app_action', action: action.action, payload: action.payload })
      break

    case 'page_jump':
      pushToBrowserSession(userId, { type: 'stream_deck_page_jump', pageId: action.pageId })
      break

    case 'webhook': {
      const method = action.method?.toUpperCase() ?? 'POST'
      try {
        const res = await fetch(action.url, {
          method,
          headers: { 'Content-Type': 'application/json', ...action.headers },
          body: action.body ?? undefined,
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) logger.warn(`[stream-deck] webhook ${action.url} → ${res.status}`)
      } catch (e) {
        logger.warn(`[stream-deck] webhook error: ${(e as Error).message}`)
      }
      break
    }
  }
}
