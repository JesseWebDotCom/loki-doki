// Telegram long-poll loop (two-way bridge). getUpdates with a 50s server-side hold;
// dispatches each update to lib/telegram/handler.ts fire-and-forget so a slow LLM turn
// never blocks polling for other chats.
//
// Offset is in-memory on purpose: Telegram replays unacked updates after a restart, and
// the handler's 5-minute staleness guard drops the replayed backlog — simpler and safer
// than persisting the offset. Generation counter + AbortController make restart
// (admin saves a new token) race-free; a no-token state re-checks every 60s so pasting
// a token in the admin panel starts the bridge without a reboot even if the restart
// hook is missed.

import { logger } from '@/lib/logger'
import { deleteWebhook, getBotToken, invalidateBotTokenCache, tgCall, TelegramApiError, type TgUpdate } from '@/lib/telegram/api'
import { handleUpdate } from '@/lib/telegram/handler'

const NO_TOKEN_RECHECK_MS = 60_000
const LONG_POLL_SECONDS = 50
// Client timeout MUST exceed the server hold: Bun's fetch has no default timeout, and
// without one a wedged socket would hang the loop forever.
const CLIENT_TIMEOUT_MS = 65_000
const MAX_BACKOFF_MS = 60_000

let generation = 0
let running = false
let controller: AbortController | null = null

export function startTelegramPoller(): void {
  if (process.env.TELEGRAM_POLLING === '0') {
    logger.info('[telegram] polling disabled via TELEGRAM_POLLING=0')
    return
  }
  if (running) return
  running = true
  void loop(++generation)
}

/** Admin saved/removed the bot token — abort the in-flight long poll and start fresh. */
export function restartTelegramPoller(): void {
  if (process.env.TELEGRAM_POLLING === '0') return
  invalidateBotTokenCache()
  generation++
  controller?.abort()
  if (!running) {
    running = true
  }
  void loop(generation)
}

async function loop(gen: number): Promise<void> {
  let offset = 0
  let backoffMs = 1000
  let announced = false
  let handled409 = false

  while (true) {
    if (gen !== generation) return // a restart superseded this loop

    const token = await getBotToken()
    if (!token) {
      announced = false
      await sleep(NO_TOKEN_RECHECK_MS)
      continue
    }
    if (!announced) {
      logger.info('[telegram] bridge polling started')
      announced = true
    }

    controller = new AbortController()
    try {
      const updates = await tgCall<TgUpdate[]>('getUpdates', {
        offset: offset || undefined,
        timeout: LONG_POLL_SECONDS,
        allowed_updates: ['message', 'callback_query'],
      }, { signal: controller.signal, timeoutMs: CLIENT_TIMEOUT_MS })
      if (gen !== generation) return
      backoffMs = 1000

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1)
        handleUpdate(update) // fire-and-forget; per-chat serialization inside
      }
    } catch (err) {
      if (gen !== generation) return
      if (err instanceof TelegramApiError && err.status === 409) {
        // A webhook is registered on this token (getUpdates conflicts with it), or a
        // second instance is polling. Clear the webhook once; if it keeps happening
        // it's two dev servers — set TELEGRAM_POLLING=0 on one.
        if (!handled409) {
          handled409 = true
          logger.warn('[telegram] 409 conflict — deleting webhook (if two servers poll this token, set TELEGRAM_POLLING=0 on one)')
          await deleteWebhook()
          continue
        }
      }
      if (!(err instanceof Error && err.name === 'AbortError')) {
        logger.warn(`[telegram] poll error (retrying in ${Math.round(backoffMs / 1000)}s): ${err instanceof Error ? err.message : err}`)
      }
      await sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
