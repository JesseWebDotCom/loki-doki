// Conversational-continuity eval — the "does it remember what it just said" probes
// from the 2026-08 companion intelligence audit. Drives the REAL /api/chat/stream
// route with MULTI-TURN scenarios in one conversation and grades the follow-up:
//
//   continuity  — the follow-up reply stays on the subject established earlier
//                 (topical-token overlap with the prior reply), with no
//                 confusion markers ("not sure what you mean", "who?")
//   routing     — the follow-up takes a sane route (e.g. "who was he?" must not
//                 web-search the literal pronoun and come back off-topic)
//   tells       — mechanical assistant-speak checks ("As an AI", "It's important
//                 to note"), applied to every reply
//
// Also runs a raw-log GREP BASELINE for the past-conversation probe: any memory
// feature must beat "just grep the transcripts" before it earns its complexity
// (audit Phase 6 rule). The baseline searches the same DB the tool searches and
// the probe fails if the tool found nothing the baseline could see.
//
// Usage:
//   bun run scripts/eval/continuity-eval.ts
//   bun run scripts/eval/continuity-eval.ts --only pronoun-follow-up
//   bun run scripts/eval/continuity-eval.ts --json out.json
import { randomBytes } from 'node:crypto'
import { db } from '@/db'
import { sessions, users, conversations, messages, memories } from '@/db/schema'
import { and, eq, gte, like } from 'drizzle-orm'
import { hashSessionToken } from '@/lib/session'

const RUN_STARTED_AT = new Date()

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000'
const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null
const jsonIdx = process.argv.indexOf('--json')
const jsonPath = jsonIdx !== -1 ? process.argv[jsonIdx + 1] : null

// ── Assistant-speak tells (mechanical; judge-free) ───────────────────────────
const ASSISTANT_TELLS: Array<{ id: string; re: RegExp }> = [
  { id: 'as-an-ai', re: /\bas an? (ai|artificial intelligence|language model|assistant)\b/i },
  { id: 'important-to-note', re: /\bit'?s (important|worth) (to note|noting)\b/i },
  { id: 'i-dont-have-feelings', re: /\bi don'?t have (feelings|emotions|personal)\b/i },
  { id: 'certainly-exclaim', re: /^(certainly|absolutely|of course)[,!]/i },
  { id: 'dive-in', re: /\blet'?s dive in\b/i },
]

function tellsIn(reply: string): string[] {
  return ASSISTANT_TELLS.filter((t) => t.re.test(reply)).map((t) => t.id)
}

// ── Scenario shapes ──────────────────────────────────────────────────────────
interface Scenario {
  id: string
  /** Turns sent in order into ONE conversation. The LAST turn is graded. */
  turns: string[]
  /** Follow-up must overlap topically with THIS earlier reply (index into replies). */
  overlapWithReply?: number
  /** Additional content expectation on the final reply. */
  expectContent?: RegExp
  /** Tools that are acceptable on the final turn; undefined = anything. */
  allowRoutes?: string[]
  /** Run the raw-log grep baseline for this scenario (past-conversation probes). */
  grepBaseline?: { term: string }
}

const SCENARIOS: Scenario[] = [
  {
    // The audit's canonical bug: pronoun follow-up must resolve "he" from the
    // prior exchange instead of searching the literal string.
    id: 'pronoun-follow-up',
    turns: ['who is the ceo of nvidia', 'how old is he?'],
    expectContent: /\b(\d{2}|huang|jensen|he)\b/i,
    overlapWithReply: 0,
  },
  {
    // "What did you just say" — the model must repeat/rephrase its own last
    // reply, not go searching or act like nothing was said.
    id: 'what-did-you-just-tell-me',
    turns: ['tell me a fun fact about octopuses', 'wait, what did you just tell me?'],
    overlapWithReply: 0,
    allowRoutes: [],
  },
  {
    // Elaboration continuation: subject lives entirely in the prior turns.
    id: 'tell-me-more',
    turns: ['what is the james webb space telescope', 'tell me more'],
    overlapWithReply: 0,
  },
  {
    // Clarify fast path: no tool, conversational answer about its own reply.
    id: 'what-did-you-mean',
    turns: ['give me one tip for sleeping better', 'what did you mean by that?'],
    overlapWithReply: 0,
    allowRoutes: [],
  },
  {
    // Past-conversation probe (same conversation, distinct topic word) + grep
    // baseline: the recall tool must at least match a dumb transcript grep.
    id: 'past-chat-recall',
    turns: ['my favorite hobby is woodworking, i love making birdhouses', 'what did we talk about earlier?'],
    overlapWithReply: 0,
    expectContent: /woodwork|birdhouse|hobby/i,
    grepBaseline: { term: 'woodworking' },
  },
]

// Confusion markers: the follow-up landed with no referent.
const CONFUSION_RE = /\b(not sure (what|who|which) you( a|')re|what (do|did) you mean|who are you (referring|talking) (to|about)|i don'?t (see|have|recall) (any|an?y? )?(previous|prior|earlier)|could you clarify what)\b/i

// ── Session setup (same pattern as companion-eval) ───────────────────────────
const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1)
if (!admin) throw new Error('no admin user')

const token = randomBytes(32).toString('hex')
const sessionId = crypto.randomUUID()
await db.insert(sessions).values({
  id: sessionId,
  userId: admin.id,
  tokenHash: hashSessionToken(token),
  expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
  createdAt: new Date(),
})

const createdConvs: string[] = []

interface TurnOut {
  reply: string
  routedTools: string[]
  conversationId: string | null
  ttfbMs: number
}

async function sendTurn(message: string, conversationId: string | null): Promise<TurnOut> {
  const start = performance.now()
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `session=${token}` },
    body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }),
  })
  const out: TurnOut = { reply: '', routedTools: [], conversationId, ttfbMs: 0 }
  if (!res.ok || !res.body) return out

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let curEvent = ''
  outer: while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      buf = buf.slice(nl + 1)
      if (line.startsWith('event:')) curEvent = line.slice(6).trim()
      else if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '')
        if (curEvent === 'token') {
          if (!out.ttfbMs) out.ttfbMs = Math.round(performance.now() - start)
          try { out.reply += (JSON.parse(data) as { text?: string })?.text ?? data } catch { out.reply += data }
        } else if (curEvent === 'routing') {
          try { out.routedTools.push((JSON.parse(data) as { tool: string }).tool) } catch { /* ignore */ }
        } else if (curEvent === 'done') {
          try {
            const d = JSON.parse(data) as { conversationId?: string }
            if (d.conversationId) {
              out.conversationId = d.conversationId
              if (!createdConvs.includes(d.conversationId)) createdConvs.push(d.conversationId)
            }
          } catch { /* ignore */ }
          break outer
        }
      }
    }
  }
  return out
}

function topicalTokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 5))]
}

function overlaps(follow: string, prior: string): boolean {
  const priorTokens = topicalTokens(prior)
  if (priorTokens.length === 0) return follow.trim().length > 0
  const f = follow.toLowerCase()
  return priorTokens.some((t) => f.includes(t))
}

interface ScenarioResult {
  id: string
  replies: string[]
  finalRoutes: string[]
  continuityOk: boolean
  routeOk: boolean
  contentOk: boolean
  tells: string[]
  baselineOk: boolean | null
  pass: boolean
}

const results: ScenarioResult[] = []
try {
  for (const sc of SCENARIOS) {
    if (only && sc.id !== only) continue
    let convId: string | null = null
    const replies: string[] = []
    let finalRoutes: string[] = []
    for (const [i, turn] of sc.turns.entries()) {
      const out = await sendTurn(turn, convId)
      convId = out.conversationId
      replies.push(out.reply)
      if (i === sc.turns.length - 1) finalRoutes = out.routedTools
    }
    const final = replies.at(-1) ?? ''
    const prior = sc.overlapWithReply !== undefined ? (replies[sc.overlapWithReply] ?? '') : ''

    const continuityOk =
      final.trim().length > 0 &&
      !CONFUSION_RE.test(final) &&
      (sc.overlapWithReply === undefined || overlaps(final, prior))
    const routeOk = sc.allowRoutes === undefined
      ? true
      : sc.allowRoutes.length === 0
        ? finalRoutes.length === 0
        : finalRoutes.every((t) => sc.allowRoutes!.includes(t))
    const contentOk = sc.expectContent ? sc.expectContent.test(final) : true
    const tells = replies.flatMap(tellsIn)

    // Grep baseline: the same store the recall tool searches must contain the
    // term via dumb LIKE — if grep can find it and the reply couldn't, the
    // memory machinery lost to the baseline.
    let baselineOk: boolean | null = null
    if (sc.grepBaseline && convId) {
      const rows = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, convId), like(messages.content, `%${sc.grepBaseline.term}%`)))
        .limit(1)
      const grepFound = rows.length > 0
      baselineOk = !grepFound || contentOk
    }

    const pass = continuityOk && routeOk && contentOk && tells.length === 0 && baselineOk !== false
    results.push({ id: sc.id, replies, finalRoutes, continuityOk, routeOk, contentOk, tells, baselineOk, pass })

    console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${sc.id}`)
    for (const [i, t] of sc.turns.entries()) {
      console.log(`  T${i + 1} user : ${t}`)
      console.log(`  T${i + 1} reply: ${(replies[i] ?? '').replace(/\s+/g, ' ').slice(0, 220)}`)
    }
    console.log(`  route  : [${finalRoutes.join(', ') || 'none'}] ${routeOk ? 'ok' : 'WRONG'}`)
    console.log(`  grade  : continuity=${continuityOk ? 'ok' : 'FAIL'} content=${contentOk ? 'ok' : 'FAIL'} tells=${tells.length === 0 ? 'none' : tells.join(',')}${sc.grepBaseline ? ` grep-baseline=${baselineOk === null ? 'skipped' : baselineOk ? 'ok' : 'LOST-TO-GREP'}` : ''}`)
  }

  const passed = results.filter((r) => r.pass).length
  console.log(`\n══ ${passed}/${results.length} passed ══`)
  if (jsonPath) await Bun.write(jsonPath, JSON.stringify(results, null, 2))
} finally {
  // Delete conversations DIRECTLY in the DB, not via the API: the API delete
  // fires a judge snapshot over the doomed messages, which raced the scrub below
  // and wrote probe "facts" (the woodworking hobby) into the REAL memory store
  // after cleanup finished. Raw row deletion gives the judge nothing to see.
  for (const id of createdConvs) {
    await db.delete(conversations).where(eq(conversations.id, id)).catch(() => {})
  }
  // Scrub what any mid-run idle sweep wrote for this user during the run window.
  await db.delete(memories)
    .where(and(eq(memories.userId, admin.id), gte(memories.createdAt, RUN_STARTED_AT)))
    .catch(() => {})
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}
process.exit(0)
