// Pod "brain" adapter — turns a transcribed utterance into a streamed text reply
// using the SAME pipeline as the chat route (routing, tools/directReply, the
// companion system prompt, recalled memory, content dials, profanity masking)
// via the shared `runCompanionTurn`.
//
// The chat route assembles its context from an HTTP request; the Pod assembles it
// from the device's bound user + companion. Conversation persistence is a route
// concern, so the Pod uses a stable synthetic conversation id (per device+user)
// purely so the memory-block cache and tool `_conversationId` have a key.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { characters, userCharacters, users } from '@/db/schema'
import { getModel } from '@/lib/models'
import { CATALOG } from '@/lib/catalog'
import { buildCompanionPrompt } from '@/lib/companionPrompt'
import { getProtections, getInteractionStyle } from '@/lib/protections'
import { getLocaleSettings } from '@/routes/adminLocale'
import {
  getUserCeiling, clampDials, parseCharacterContent,
} from '@/lib/contentPolicy'
import type { ContentDials } from '@/lib/contentPolicy'
import type { OllamaChatMessage } from '@/llm/ollama'
import { runCompanionTurn, loadUserPrefs, type CompanionTurnParams } from '@/lib/companionTurn'

export interface PodBrainOptions {
  /** The device's bound user (from the `devices` table — phase: device identity). */
  userId: string
  /** Optional companion to speak as. */
  characterId?: string | null
  /** Prior turns for this device session (kept short by the caller). */
  history?: OllamaChatMessage[]
  /** Stable per-device conversation id for the memory cache / tool context. */
  convId: string
  /** Device-group reply-length override ('inherit' or unset → use the character's). */
  replyStyleOverride?: string | null
  signal: { readonly aborted: boolean }
}

/**
 * Stream the companion's reply to `text`, one chunk at a time. Bridges the
 * push-based `runCompanionTurn` into a pull-based async generator so the Pod
 * session can `for await` it.
 */
export async function* runPodBrain(text: string, opts: PodBrainOptions): AsyncGenerator<string> {
  const params = await buildTurnParams(text, opts)
  if (!params) return // user/character gate failed — stay silent

  const queue: string[] = []
  let done = false
  let wake: (() => void) | null = null
  const ping = () => { wake?.(); wake = null }

  const turn = runCompanionTurn(params, {
    onToken: (t) => { queue.push(t); ping() },
    signal: opts.signal,
  }).finally(() => { done = true; ping() })

  while (true) {
    if (queue.length) { yield queue.shift()!; continue }
    if (done) break
    await new Promise<void>((r) => { wake = r })
  }
  await turn // surface any rejection
}

/** Resolve the device user's prefs/character/dials into CompanionTurnParams. */
async function buildTurnParams(
  message: string,
  opts: PodBrainOptions,
): Promise<CompanionTurnParams | null> {
  const characterId = opts.characterId ?? null
  const [user, prefs, charRow, locale, protections, interactionStyle, userCeiling] = await Promise.all([
    db.select().from(users).where(eq(users.id, opts.userId)).limit(1).then((r) => r[0] ?? null),
    loadUserPrefs(opts.userId),
    characterId
      ? db.select().from(characters).where(eq(characters.id, characterId)).limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    getLocaleSettings(),
    getProtections(opts.userId),
    getInteractionStyle(opts.userId),
    getUserCeiling(opts.userId),
  ])
  if (!user) return null

  // Content dials: the user's profile ceiling; a character runs its own config
  // CLAMPED to that ceiling (same rule as the chat route).
  const charContent = charRow ? parseCharacterContent(charRow.contentDials) : null
  const activeDials: ContentDials = charContent ? clampDials(charContent.dials, userCeiling) : userCeiling
  const activeInteractionStyle = charContent
    ? { ...interactionStyle, candor: charContent.candor }
    : interactionStyle
  const maskProfanityActive = activeDials.profanity === 'off'

  // Record the relationship so the companion's first-met memory etc. behave like
  // the chat route (best-effort; persistence is not the Pod's concern).
  if (characterId && charRow) {
    db.insert(userCharacters)
      .values({ id: crypto.randomUUID(), userId: opts.userId, characterId, createdAt: new Date() })
      .onConflictDoNothing()
      .catch(() => {})
  }

  let model = (prefs['chat_model'] as string | undefined) ?? await getModel()
  if (protections.blockUncensoredLlm && model) {
    const catalogEntry = CATALOG.find((m) => m.id === model)
    if (catalogEntry && (catalogEntry.role === 'uncensored_llm' || catalogEntry.tags?.includes('uncensored'))) {
      model = await getModel()
    }
  }
  const options: Record<string, unknown> = {
    temperature: (prefs['temperature'] as number | undefined) ?? 0.7,
    num_ctx: (prefs['ctx_limit'] as number | undefined) ?? 4096,
    num_predict: (prefs['max_tokens'] as number | undefined) ?? 2048,
  }
  if (prefs['seed']) options['seed'] = prefs['seed']

  // A device-group setting (e.g. "brief") overrides the character's own reply style;
  // 'inherit' / unset leaves the character's choice alone.
  const replyStyle = opts.replyStyleOverride && opts.replyStyleOverride !== 'inherit'
    ? opts.replyStyleOverride
    : charRow?.replyStyle
  const characterSystemPrompt = charRow
    ? buildCompanionPrompt({ personalityPrompt: charRow.personalityPrompt, replyStyle, style: charRow.style, avatarConfig: charRow.avatarConfig })
    : null

  return {
    userId: opts.userId,
    userRole: user.role,
    userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
    model,
    options,
    message,
    characterId,
    characterSystemPrompt,
    uiContext: null,
    clientLat: null,
    clientLng: null,
    convId: opts.convId,
    history: opts.history ?? [],
    prefs,
    cookieHeader: '',
    locale,
    interactionStyle: activeInteractionStyle,
    activeDials,
    maskProfanityActive,
  }
}
