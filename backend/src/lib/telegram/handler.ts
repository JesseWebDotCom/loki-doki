// Telegram update router — the two-way bridge's brain hookup. Incoming private-chat
// messages from linked users run through the SAME companion pipeline as chat/overlay/pod
// (runCompanionTurn: routing, tools, memory, HA grants, content dials), with the
// conversation persisted in the real conversations/messages tables (convId
// `tg:<userId>:<chatId>`) so history, the memory judge sweep, and the HA pending-action
// confirm flow all work unchanged. URL-only messages become bookmarks instead of turns.

import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarks, conversations, messages, userCharacters, userPreferences, users } from '@/db/schema'
import { logger } from '@/lib/logger'
import { runCompanionTurn, resolveTurnContext, type CompanionTurnParams } from '@/lib/companionTurn'
import { getLinkedUser, redeemLinkCode } from '@/lib/notify/telegramLink'
import { createBookmark } from '@/lib/bookmarks/create'
import { enqueueArchiveArticle } from '@/lib/downloadJobs'
import { ctxKey, clearPendingAction, hasPendingAction } from '@/lib/homeAssistant/context'
import {
  answerCallbackQuery, editMessageReplyMarkup, editMessageText,
  sendChatAction, sendTelegramMessage,
  type TgCallbackQuery, type TgInlineKeyboard, type TgMessage, type TgUpdate,
} from '@/lib/telegram/api'

// Ignore updates older than this — Telegram replays unacked updates after a restart
// (the poller's offset is in-memory) and stale chats must not trigger LLM turns.
const STALE_MESSAGE_MS = 5 * 60 * 1000

// One turn at a time per chat; a short queue so a fast follow-up isn't dropped.
const MAX_QUEUE_DEPTH = 2
const chatQueues = new Map<number, { chain: Promise<void>; depth: number }>()

const LINK_HINT = 'This bot is private. To link your account, open the app → Settings → Notifications → Link Telegram, then send me the code (or use the button there).'

export function handleUpdate(update: TgUpdate): void {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id
  if (chatId === undefined) return
  const entry = chatQueues.get(chatId) ?? { chain: Promise.resolve(), depth: 0 }
  if (entry.depth >= MAX_QUEUE_DEPTH) {
    void sendTelegramMessage(chatId, "Hold on — I'm still working on your last message.")
    return
  }
  entry.depth++
  entry.chain = entry.chain
    .then(() => processUpdate(update))
    .catch((err) => logger.warn(`[telegram] update failed: ${err}`))
    .finally(() => {
      const e = chatQueues.get(chatId)
      if (e) {
        e.depth--
        if (e.depth <= 0) chatQueues.delete(chatId)
      }
    })
  chatQueues.set(chatId, entry)
}

async function processUpdate(update: TgUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(update.callback_query)
  const msg = update.message
  if (!msg) return
  if (msg.chat.type !== 'private') return // v1 is DM-only; stay silent in groups
  if (msg.date * 1000 < Date.now() - STALE_MESSAGE_MS) return

  const chatId = msg.chat.id
  const text = msg.text?.trim() ?? ''

  // /start [CODE] — link redemption (deep link puts the code in the start payload).
  const start = /^\/start(?:\s+(\S+))?/.exec(text)
  if (start) return handleStart(msg, start[1])

  const linked = await getLinkedUser(chatId)
  if (!linked) {
    // A bare code counts too — people paste just the code instead of /start CODE.
    if (/^[A-Z0-9]{6}$/i.test(text) && (await tryRedeem(msg, text))) return
    await sendTelegramMessage(chatId, LINK_HINT)
    return
  }

  if (!text) {
    if (msg.photo?.length) {
      await sendTelegramMessage(chatId, "I can't see photos here yet — send me text or a link.")
    }
    return
  }

  // URL-only message (optionally followed by a short note) → save to bookmarks.
  const urlOnly = /^(https?:\/\/\S+)\s*([\s\S]{0,80})$/.exec(text)
  if (urlOnly && !/\s/.test(urlOnly[1]!)) {
    return saveUrl(linked.userId, chatId, urlOnly[1]!, urlOnly[2]?.trim() ?? '')
  }

  return runTelegramTurn(linked.userId, chatId, text, msg.message_id)
}

// ── Linking ────────────────────────────────────────────────────────────────────

async function handleStart(msg: TgMessage, code: string | undefined): Promise<void> {
  const chatId = msg.chat.id
  if (code && (await tryRedeem(msg, code))) return
  const linked = await getLinkedUser(chatId)
  if (linked) {
    await sendTelegramMessage(chatId, "You're already linked. Send me a message, a link to save, or a home command.")
  } else {
    await sendTelegramMessage(chatId, LINK_HINT)
  }
}

async function tryRedeem(msg: TgMessage, code: string): Promise<boolean> {
  const res = await redeemLinkCode(code, msg.chat.id, {
    username: msg.from?.username,
    firstName: msg.from?.first_name,
  })
  if (!res) {
    await sendTelegramMessage(msg.chat.id, "That link code wasn't recognized — it may have expired. Generate a fresh one in Settings → Notifications.")
    return false
  }
  const [user] = await db.select().from(users).where(eq(users.id, res.userId)).limit(1)
  const name = user?.nickname?.trim() || user?.firstName?.trim() || 'there'
  await sendTelegramMessage(msg.chat.id, `Linked! You're chatting as ${name}. 🎉\n\nSend me a message to talk to your companion, a link to save it to your bookmarks, or a home command like "turn off the kitchen lights".`)
  return true
}

// ── Save-a-link ────────────────────────────────────────────────────────────────

async function saveUrl(userId: string, chatId: number, url: string, note: string): Promise<void> {
  try {
    const item = await createBookmark({
      ownerId: userId,
      url,
      title: note || undefined,
      type: 'live',
      category: 'Telegram',
    })
    const keyboard: TgInlineKeyboard = {
      inline_keyboard: [[{ text: '📦 Save offline copy', callback_data: `bm:off:${item.id}` }]],
    }
    await sendTelegramMessage(chatId, `🔖 Saved: ${item.title}`, { replyMarkup: keyboard })
  } catch (err) {
    logger.warn(`[telegram] save url failed: ${err}`)
    await sendTelegramMessage(chatId, "Couldn't save that link — try again in a bit.")
  }
}

// ── Companion turn ─────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 40
const TOKEN_HISTORY_BUDGET = 800

/** Drop oldest messages until the estimated token count fits (mirrors chat.ts). */
function trimHistory(rows: Array<{ content: string }>, budget: number): void {
  while (rows.length > 4) {
    const tokens = rows.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0)
    if (tokens <= budget) break
    rows.shift()
  }
}

export async function runTelegramTurn(userId: string, chatId: number, text: string, replyTo?: number): Promise<void> {
  const convId = `tg:${userId}:${chatId}`

  // Which companion answers on Telegram (user pref; null = plain assistant).
  const [charPref] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'telegram.character_id')))
    .limit(1)
  let characterId: string | null = null
  try { characterId = charPref ? (JSON.parse(charPref.value) as string | null) : null } catch { /* default */ }

  const [user, ctx, relation] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1).then((r) => r[0] ?? null),
    resolveTurnContext(userId, characterId),
    characterId
      ? db.select({ createdAt: userCharacters.createdAt }).from(userCharacters)
          .where(and(eq(userCharacters.userId, userId), eq(userCharacters.characterId, characterId)))
          .limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ])
  if (!user) return

  // Character may have been deleted / access revoked — resolveTurnContext handles the
  // gate; record first-met like the other surfaces when it resolved.
  if (characterId && ctx.charRow) {
    db.insert(userCharacters)
      .values({ id: crypto.randomUUID(), userId, characterId, createdAt: new Date() })
      .onConflictDoNothing()
      .catch(() => {})
  }

  // Real conversation row so the memory sweep processes Telegram chats (it appears in
  // the web sidebar as "Telegram" — deleting it there is harmless, it's recreated here).
  await db.insert(conversations)
    .values({ id: convId, userId, characterId: ctx.charRow ? characterId : null, title: 'Telegram', createdAt: new Date(), updatedAt: new Date() })
    .onConflictDoNothing()

  // History: same pattern as the chat route (last 40 desc → reversed, toolNote folded,
  // token-trimmed).
  const dbRows = await db
    .select({ role: messages.role, content: messages.content, toolNote: messages.toolNote })
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT)
  dbRows.reverse()
  const history = dbRows.map((m) => ({
    role: m.role,
    content: m.toolNote ? `${m.content}\n\n[tool data behind this reply: ${m.toolNote}]` : m.content,
  }))
  trimHistory(history, TOKEN_HISTORY_BUDGET)

  await db.insert(messages).values({
    id: crypto.randomUUID(), conversationId: convId, role: 'user', content: text, createdAt: new Date(),
  })

  // Typing indicator until the turn resolves (the action expires after ~5s).
  await sendChatAction(chatId)
  const typing = setInterval(() => void sendChatAction(chatId), 4500)

  let maskedText = ''
  let haConfirm = false
  try {
    const params: CompanionTurnParams = {
      userId,
      userRole: user.role,
      userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
      model: ctx.model,
      options: ctx.options,
      message: text,
      characterId: ctx.charRow ? characterId : null,
      characterSystemPrompt: ctx.characterSystemPrompt,
      uiContext: null,
      clientLat: null,
      clientLng: null,
      convId,
      history,
      prefs: ctx.prefs,
      firstMetAt: characterId ? (relation?.createdAt ?? null) : undefined,
      cookieHeader: '',
      locale: ctx.locale,
      interactionStyle: ctx.interactionStyle,
      activeDials: ctx.activeDials,
      maskProfanityActive: ctx.maskProfanityActive,
      surface: 'telegram',
      harnessLine: "You're chatting over Telegram. Keep replies conversational plain text — no markdown tables, headers, or code fences.",
      includeDocs: false, // synthetic conversation id — no attached documents
    }

    const result = await runCompanionTurn(params, {
      onToken: (t) => { maskedText += t },
      onEvent: (type, data) => {
        if (type !== 'tool_data') return
        try {
          const parsed = JSON.parse(data) as { tool?: string; data?: { intent?: string } }
          if (parsed.tool === 'homeAssistant' && parsed.data?.intent === 'confirm') haConfirm = true
        } catch { /* not the confirm event */ }
      },
      signal: { aborted: false },
    })

    if (result.text.trim()) {
      // Persist RAW text (mask-at-read contract); SEND the masked stream accumulation.
      const now = new Date()
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: convId,
        role: 'assistant',
        content: result.text,
        toolNote: result.toolNote ?? null,
        truncated: !result.completed || (result.capped ?? false),
        createdAt: now,
      })
      await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, convId))

      const keyboard: TgInlineKeyboard | undefined = haConfirm
        ? { inline_keyboard: [[{ text: '✅ Yes', callback_data: 'ha:yes' }, { text: '❌ Cancel', callback_data: 'ha:no' }]] }
        : undefined
      await sendTelegramMessage(chatId, maskedText.trim() || result.text, { replyMarkup: keyboard, replyToMessageId: replyTo })
    } else if (!result.completed) {
      await sendTelegramMessage(chatId, "Something went wrong on my end — try that again?")
    }
  } catch (err) {
    logger.warn(`[telegram] turn failed: ${err}`)
    await sendTelegramMessage(chatId, "Something went wrong on my end — try that again?")
  } finally {
    clearInterval(typing)
  }
}

// ── Inline-button callbacks ────────────────────────────────────────────────────

async function handleCallback(cb: TgCallbackQuery): Promise<void> {
  const chatId = cb.message?.chat.id
  const messageId = cb.message?.message_id
  if (chatId === undefined || messageId === undefined) {
    await answerCallbackQuery(cb.id)
    return
  }
  const linked = await getLinkedUser(chatId)
  if (!linked) {
    await answerCallbackQuery(cb.id)
    return
  }
  const data = cb.data ?? ''
  const convId = `tg:${linked.userId}:${chatId}`

  if (data === 'ha:yes') {
    if (!hasPendingAction(linked.userId, convId)) {
      await answerCallbackQuery(cb.id, 'That request expired — ask me again.')
      await editMessageReplyMarkup(chatId, messageId, null)
      return
    }
    await answerCallbackQuery(cb.id, 'On it…')
    await editMessageReplyMarkup(chatId, messageId, null)
    // 'yes' re-enters the pipeline; companionTurn force-routes it to the HA tool,
    // which executes the parked plan and replies in-voice.
    await runTelegramTurn(linked.userId, chatId, 'yes')
    return
  }

  if (data === 'ha:no') {
    clearPendingAction(ctxKey(linked.userId, convId))
    await answerCallbackQuery(cb.id, 'Cancelled')
    await editMessageReplyMarkup(chatId, messageId, null)
    await sendTelegramMessage(chatId, 'Okay — cancelled.')
    return
  }

  const bmOff = /^bm:off:([0-9a-f-]{36})$/.exec(data)
  if (bmOff) {
    const id = bmOff[1]!
    const [item] = await db.select().from(bookmarks)
      .where(and(eq(bookmarks.id, id), eq(bookmarks.ownerId, linked.userId)))
      .limit(1)
    if (!item) {
      await answerCallbackQuery(cb.id, "Couldn't find that bookmark anymore.")
      return
    }
    await db.update(bookmarks)
      .set({ type: 'offline', source: 'article', archiveState: 'pending', archiveError: null, updatedAt: new Date() })
      .where(eq(bookmarks.id, id))
    await enqueueArchiveArticle(id, item.title || item.url)
    await answerCallbackQuery(cb.id, 'Archiving…')
    await editMessageText(chatId, messageId, `🔖 Saved — archiving an offline copy: ${item.title || item.url}`, { replyMarkup: null })
    return
  }

  await answerCallbackQuery(cb.id)
}
