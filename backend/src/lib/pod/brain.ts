// Pod "brain" adapter — turns a transcribed utterance into a streamed text reply
// using the SAME pipeline as the chat route (routing, tools/directReply, the
// companion system prompt, recalled memory, content dials, profanity masking)
// via the shared `runCompanionTurn`.
//
// The chat route assembles its context from an HTTP request; the Pod assembles it
// from the device's bound user + companion. Conversation persistence is a route
// concern, so the Pod uses a stable synthetic conversation id (per device+user)
// purely so the memory-block cache and tool `_conversationId` have a key.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userCharacters, users } from '@/db/schema'
import type { OllamaChatMessage } from '@/llm/ollama'
import { runCompanionTurn, resolveTurnContext, type CompanionTurnParams } from '@/lib/companionTurn'

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
  const [user, ctx, relation] = await Promise.all([
    db.select().from(users).where(eq(users.id, opts.userId)).limit(1).then((r) => r[0] ?? null),
    // The SAME context resolver as the chat route and the overlay — prefs,
    // character persona (with the device-group reply-style override), dial
    // clamping, model selection.
    resolveTurnContext(opts.userId, characterId, { replyStyleOverride: opts.replyStyleOverride }),
    characterId
      ? db.select({ createdAt: userCharacters.createdAt }).from(userCharacters)
          .where(and(eq(userCharacters.userId, opts.userId), eq(userCharacters.characterId, characterId)))
          .limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ])
  if (!user) return null

  // Record the relationship so the companion's first-met memory etc. behave like
  // the chat route (best-effort; persistence is not the Pod's concern).
  if (characterId && ctx.charRow) {
    db.insert(userCharacters)
      .values({ id: crypto.randomUUID(), userId: opts.userId, characterId, createdAt: new Date() })
      .onConflictDoNothing()
      .catch(() => {})
  }

  return {
    userId: opts.userId,
    userRole: user.role,
    userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
    model: ctx.model,
    options: ctx.options,
    message,
    characterId,
    characterSystemPrompt: ctx.characterSystemPrompt,
    uiContext: null,
    clientLat: null,
    clientLng: null,
    convId: opts.convId,
    history: opts.history ?? [],
    prefs: ctx.prefs,
    firstMetAt: characterId ? (relation?.createdAt ?? null) : undefined,
    cookieHeader: '',
    locale: ctx.locale,
    interactionStyle: ctx.interactionStyle,
    activeDials: ctx.activeDials,
    maskProfanityActive: ctx.maskProfanityActive,
    surface: 'pod',
    includeDocs: false, // synthetic conversation id — no attached documents
  }
}
