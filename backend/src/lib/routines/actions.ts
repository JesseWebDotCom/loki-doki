// Routine action execution. Deterministic actions (notify, announce, ha-action)
// are plain code. ask-companion is the ONE deliberately agentic action: it runs a
// full headless companion turn (routing, tools, memory) for the routine's OWNER,
// so tool access is bounded by that user's existing tool permissions, then
// delivers the text via notify (which fans out to push/telegram/email per the
// user's routing matrix) or spoken on their pods.

import { emitNotification } from '@/lib/notify'
import { podsForUser } from '@/lib/pod/registry'
import { logger } from '@/lib/logger'
import type { RoutineAction } from './types'

export interface ActionContext {
  routineId: string
  routineName: string
  userId: string
}

/** Execute one action; throws on failure (the engine records per-action results). */
export async function executeAction(action: RoutineAction, ctx: ActionContext): Promise<string> {
  switch (action.type) {
    case 'notify': {
      await emitNotification({
        type: 'system',
        userId: ctx.userId,
        payload: { message: action.body ? `${action.title}: ${action.body}` : action.title },
        title: action.title,
        body: action.body ?? `From your routine "${ctx.routineName}".`,
        url: '/routines',
      })
      return 'notified'
    }

    case 'announce': {
      const spoken = speakOnPods(ctx.userId, action.text)
      if (spoken > 0) return `announced on ${spoken} device${spoken === 1 ? '' : 's'}`
      // Nothing is listening; fall back to a notification so the routine is never silent.
      await emitNotification({
        type: 'system',
        userId: ctx.userId,
        payload: { message: `${ctx.routineName}: ${action.text}` },
        title: ctx.routineName,
        body: action.text,
        url: '/routines',
      })
      return 'no device online; sent as notification'
    }

    case 'ha-action': {
      const [{ getGlobalConnection }, { serviceCallsFor, VALID_ACTIONS }, { callService }] = await Promise.all([
        import('@/lib/homeAssistant'),
        import('@/lib/homeAssistant/actions'),
        import('@/lib/homeAssistant/client'),
      ])
      if (!VALID_ACTIONS.has(action.action as never)) throw new Error(`Unknown home action: ${action.action}`)
      const conn = await getGlobalConnection()
      if (!conn) throw new Error('Home Assistant is not connected.')
      const calls = serviceCallsFor(action.action as never, action.entityIds, {
        brightnessPct: action.brightnessPct,
        value: action.value,
        hvacMode: action.hvacMode as never,
      })
      for (const call of calls) {
        const result = await callService(conn, call.domain, call.service, call.data)
        if (!result.ok) throw new Error(`Home Assistant refused ${call.domain}.${call.service}: ${result.error ?? 'unknown error'}`)
      }
      return `ran ${calls.length} home call${calls.length === 1 ? '' : 's'}`
    }

    case 'ask-companion': {
      const text = await runHeadlessCompanionTurn(ctx.userId, action.prompt)
      if (!text.trim()) throw new Error('The companion returned nothing.')
      if (action.deliver === 'announce') {
        const spoken = speakOnPods(ctx.userId, text)
        if (spoken > 0) return `companion spoke on ${spoken} device${spoken === 1 ? '' : 's'}`
      }
      await emitNotification({
        type: 'system',
        userId: ctx.userId,
        payload: { message: `${ctx.routineName}: ${text}` },
        title: ctx.routineName,
        body: text,
        url: '/routines',
      })
      return 'companion replied; delivered as notification'
    }
  }
}

function speakOnPods(userId: string, text: string): number {
  let spoken = 0
  for (const pod of podsForUser(userId)) {
    try {
      void pod.testSpeak(text)
      spoken++
    } catch (err) {
      logger.warn(`[routines] pod speak failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  return spoken
}

/** One-shot companion turn with no client attached: tokens are collected, tool
 *  routing and permissions work exactly as in chat, and the reply is capped to
 *  something deliverable in a notification. */
async function runHeadlessCompanionTurn(userId: string, prompt: string): Promise<string> {
  const [{ runCompanionTurn, resolveTurnContext }, { db }, { users }] = await Promise.all([
    import('@/lib/companionTurn'),
    import('@/db'),
    import('@/db/schema').then((m) => ({ users: m.users })).then((users) => users),
  ])
  const { eq } = await import('drizzle-orm')
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) throw new Error('Routine owner no longer exists.')
  const ctx = await resolveTurnContext(userId, null)

  let text = ''
  const result = await runCompanionTurn(
    {
      userId,
      userRole: user.role,
      userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
      model: ctx.model,
      options: { ...ctx.options, num_predict: 500 },
      message: prompt,
      characterId: null,
      characterSystemPrompt: ctx.characterSystemPrompt,
      uiContext: null,
      clientLat: null,
      clientLng: null,
      clientTz: null,
      convId: `routine:${userId}`,
      history: [],
      prefs: ctx.prefs,
      cookieHeader: '',
      locale: ctx.locale,
      interactionStyle: ctx.interactionStyle,
      activeDials: ctx.activeDials,
      maskProfanityActive: ctx.maskProfanityActive,
      surface: 'telegram', // closest existing surface: plain-text, no client UI attached
      harnessLine: 'This request comes from a scheduled routine, not a live chat. Answer completely in plain text; the user reads it later as a notification.',
      includeDocs: false,
    },
    {
      onToken: (t) => { text += t },
      onEvent: () => { /* no client to receive directives */ },
      signal: { aborted: false },
    },
  )
  return (text.trim() || result.text || '').trim()
}
