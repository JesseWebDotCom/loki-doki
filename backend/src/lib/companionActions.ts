import type { ConfirmActionDirective } from '../tools/index'

// Surface-agnostic staged-action store for companion confirmations.
//
// The pattern (proven first by Home Assistant security actions): a tool that is
// about to do something sendable, destructive, or physical does NOT execute.
// It STAGES the work here as a closure, replies asking for confirmation, and
// attaches a confirm_action directive so every surface (chat block, dock
// bubble, HUD island, mobile sheet, Telegram inline keyboard) can render
// approve/decline buttons. The next affirmative (typed "yes", spoken "yes" in
// the follow-up window, a button click re-entering the turn, or the REST
// endpoint) resolves it. resolveAction is single-use and deletes BEFORE
// executing, so racing resolvers are strictly first-wins.
//
// The execute closure stays in process memory and is never serialized; the
// directive carries only the id and display strings.

export interface StagedAction {
  id: string
  userId: string
  /** Chat conversation id, or a per-surface synthetic key (off-chat companion,
   *  Telegram chat). Only used to find "the pending action for this thread". */
  conversationId: string
  /** Origin tool id, for logging and replies. */
  toolId: string
  /** Human phrasing of the staged work, e.g. 'unlock the Front Door'. */
  summary: string
  approveLabel: string
  declineLabel: string
  /** Optional rich preview carried into the directive (poster + title for media requests). */
  card?: { title: string; subtitle?: string; imageUrl?: string }
  /** The parked work; returns the speakable outcome reply. */
  execute: () => Promise<string>
  createdAt: number
}

const PENDING_TTL_MS = 60_000

const byId = new Map<string, StagedAction>()
const byConv = new Map<string, string>()

const convKey = (userId: string, conversationId: string) => `${userId}:${conversationId}`

function sweep(): void {
  const now = Date.now()
  for (const [id, a] of byId) {
    if (now - a.createdAt > PENDING_TTL_MS) {
      byId.delete(id)
      if (byConv.get(convKey(a.userId, a.conversationId)) === id) {
        byConv.delete(convKey(a.userId, a.conversationId))
      }
    }
  }
}

export function stageAction(a: Omit<StagedAction, 'id' | 'createdAt'>): StagedAction {
  sweep()
  const staged: StagedAction = { ...a, id: crypto.randomUUID(), createdAt: Date.now() }
  // One pending per conversation: staging replaces any prior offer.
  const key = convKey(a.userId, a.conversationId)
  const prior = byConv.get(key)
  if (prior) byId.delete(prior)
  byId.set(staged.id, staged)
  byConv.set(key, staged.id)
  return staged
}

/** Stage + build the matching directive in one call (the common tool shape). */
export function stageWithDirective(a: Omit<StagedAction, 'id' | 'createdAt'>): {
  staged: StagedAction
  directive: ConfirmActionDirective
} {
  const staged = stageAction(a)
  return {
    staged,
    directive: {
      action: 'confirm_action',
      actionId: staged.id,
      summary: staged.summary,
      approveLabel: staged.approveLabel,
      declineLabel: staged.declineLabel,
      ...(staged.card ? { card: staged.card } : {}),
    },
  }
}

export function getActionById(id: string): StagedAction | null {
  sweep()
  return byId.get(id) ?? null
}

export function getPendingForConversation(userId: string, conversationId: string): StagedAction | null {
  sweep()
  const id = byConv.get(convKey(userId, conversationId))
  return id ? (byId.get(id) ?? null) : null
}

export function hasPendingCompanionAction(userId: string, conversationId: string): boolean {
  return getPendingForConversation(userId, conversationId) !== null
}

export function clearPending(userId: string, conversationId: string): void {
  const key = convKey(userId, conversationId)
  const id = byConv.get(key)
  if (id) byId.delete(id)
  byConv.delete(key)
}

/** Single-use resolve. Deletes the action BEFORE executing so a button click,
 *  a spoken "yes", a second tab, and the REST endpoint can race safely: exactly
 *  one caller executes, the rest get null ("nothing pending"). */
export async function resolveAction(
  id: string,
  approve: boolean,
): Promise<{ ok: boolean; reply: string } | null> {
  const a = getActionById(id)
  if (!a) return null
  byId.delete(id)
  const key = convKey(a.userId, a.conversationId)
  if (byConv.get(key) === id) byConv.delete(key)
  if (!approve) return { ok: true, reply: 'Okay, cancelled.' }
  try {
    const reply = await a.execute()
    return { ok: true, reply }
  } catch (err) {
    console.error(`[companionActions] staged ${a.toolId} action failed:`, err)
    return { ok: false, reply: `I hit a snag trying to ${a.summary}. Nothing was changed.` }
  }
}

// ── Confirmation-reply detection (moved from homeAssistant/context.ts, these
// are generic yes/no matchers, not HA-specific) ───────────────────────────────

const AFFIRM_RE = /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|go for it|please do|affirmative|proceed)\b/i
const NEGATE_RE = /^\s*(?:no|nope|nah|cancel|never\s?mind|nevermind|don'?t|stop|forget it|negative)\b/i

/** Does this message look like a yes/no answer to a pending confirmation? */
export function isConfirmationReply(message: string): boolean {
  return AFFIRM_RE.test(message) || NEGATE_RE.test(message)
}

export function isAffirmative(message: string): boolean {
  return AFFIRM_RE.test(message)
}

export function isNegative(message: string): boolean {
  return NEGATE_RE.test(message)
}
