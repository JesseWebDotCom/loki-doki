// Raw Telegram Bot API client — deliberately dependency-free (fetch), matching how the
// rest of the backend talks to external APIs (push.ts, feeds poller). Shared by the
// notification adapter (lib/notify/adapters/telegram.ts) and the two-way bridge
// (lib/telegram/poller.ts / handler.ts). Token lives in app_settings 'telegram.bot_token'.

import { getAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

const TOKEN_SETTING_KEY = 'telegram.bot_token'
const TOKEN_CACHE_TTL_MS = 30_000

// Telegram hard limit per sendMessage call.
const MAX_MESSAGE_CHARS = 4096

let tokenCache: { value: string | null; at: number } | null = null

export async function getBotToken(): Promise<string | null> {
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_CACHE_TTL_MS) return tokenCache.value
  const raw = await getAppSetting(TOKEN_SETTING_KEY)
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  tokenCache = { value, at: Date.now() }
  return value
}

export function invalidateBotTokenCache(): void {
  tokenCache = null
}

export class TelegramApiError extends Error {
  constructor(
    public method: string,
    public status: number,
    public description: string,
    public retryAfter?: number,
  ) {
    super(`telegram ${method} failed (${status}): ${description}`)
  }
}

// ── Wire types (only the fields we actually read) ─────────────────────────────

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

export interface TgMessage {
  message_id: number
  date: number // unix seconds
  text?: string
  photo?: unknown[]
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
  from?: { id: number; username?: string; first_name?: string }
}

export interface TgCallbackQuery {
  id: string
  data?: string
  from: { id: number; username?: string; first_name?: string }
  message?: { message_id: number; chat: { id: number; type: string } }
}

export interface TgInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

interface TgApiEnvelope<T> {
  ok: boolean
  result?: T
  description?: string
  parameters?: { retry_after?: number }
}

/** Low-level Bot API call. Throws TelegramApiError on API-level failure (including 429,
 *  which carries retryAfter). Throws plain fetch errors on network failure. Bun's fetch
 *  has NO default timeout, so every call gets one — long-poll callers pass their own. */
export async function tgCall<T>(
  method: string,
  payload?: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const token = await getBotToken()
  if (!token) throw new TelegramApiError(method, 0, 'bot token not configured')

  const signals: AbortSignal[] = [AbortSignal.timeout(opts.timeoutMs ?? 15_000)]
  if (opts.signal) signals.push(opts.signal)

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.any(signals),
  })
  const data = (await res.json().catch(() => null)) as TgApiEnvelope<T> | null
  if (!data?.ok) {
    throw new TelegramApiError(method, res.status, data?.description ?? `HTTP ${res.status}`, data?.parameters?.retry_after)
  }
  return data.result as T
}

/** getMe — used by the admin panel to validate a token and to build t.me deep links. */
export async function getBotInfo(): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const me = await tgCall<{ username?: string }>('getMe')
    return { ok: true, username: me.username }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Split at Telegram's 4096-char limit, preferring paragraph then line boundaries so we
 *  never cut mid-word unless a single line is itself over the limit. */
export function chunkMessage(text: string): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > MAX_MESSAGE_CHARS) {
    const window = rest.slice(0, MAX_MESSAGE_CHARS)
    let cut = window.lastIndexOf('\n\n')
    if (cut < MAX_MESSAGE_CHARS / 2) cut = window.lastIndexOf('\n')
    if (cut < MAX_MESSAGE_CHARS / 2) cut = window.lastIndexOf(' ')
    if (cut < MAX_MESSAGE_CHARS / 2) cut = MAX_MESSAGE_CHARS
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

/** Send plain text (no parse_mode — MarkdownV2 escaping corrupts LLM output too easily),
 *  chunked to the 4096 limit, with one automatic retry after a 429. Best-effort: returns
 *  the last message_id, or null when the bot is unconfigured or the send failed — the
 *  notification dispatcher calls this unconditionally and treats null as "not delivered". */
export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  opts: { replyMarkup?: TgInlineKeyboard; replyToMessageId?: number } = {},
): Promise<number | null> {
  if (!(await getBotToken())) return null
  const chunks = chunkMessage(text.trim() || '…')
  let lastId: number | null = null
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      disable_web_page_preview: true,
      // Keyboard goes on the final chunk only (it's the one the user acts on).
      ...(isLast && opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      ...(i === 0 && opts.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
    }
    try {
      const msg = await tgCall<{ message_id: number }>('sendMessage', payload)
      lastId = msg.message_id
    } catch (err) {
      if (err instanceof TelegramApiError && err.status === 429 && err.retryAfter) {
        await new Promise((r) => setTimeout(r, (err.retryAfter! + 1) * 1000))
        try {
          const msg = await tgCall<{ message_id: number }>('sendMessage', payload)
          lastId = msg.message_id
          continue
        } catch (retryErr) {
          logger.warn(`[telegram] send retry failed: ${(retryErr as Error).message}`)
          return lastId
        }
      }
      logger.warn(`[telegram] send failed: ${(err as Error).message}`)
      return lastId
    }
  }
  return lastId
}

export async function sendChatAction(chatId: number | string, action = 'typing'): Promise<void> {
  await tgCall('sendChatAction', { chat_id: chatId, action }).catch(() => {})
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await tgCall('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }).catch(() => {})
}

export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  opts: { replyMarkup?: TgInlineKeyboard | null } = {},
): Promise<void> {
  await tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...(opts.replyMarkup !== undefined ? { reply_markup: opts.replyMarkup ?? { inline_keyboard: [] } } : {}),
  }).catch(() => {})
}

export async function editMessageReplyMarkup(
  chatId: number | string,
  messageId: number,
  markup: TgInlineKeyboard | null,
): Promise<void> {
  await tgCall('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: markup ?? { inline_keyboard: [] },
  }).catch(() => {})
}

/** getUpdates 409s while a webhook is registered; the poller calls this once on 409. */
export async function deleteWebhook(): Promise<void> {
  await tgCall('deleteWebhook').catch(() => {})
}
