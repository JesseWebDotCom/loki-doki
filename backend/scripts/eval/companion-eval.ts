// Companion answer-quality eval — drives the REAL /api/chat/stream route with a
// battery of factual/tool prompts and grades every reply on four axes:
//
//   directness  — the answer leads; no greeting, no time-of-day acknowledgement,
//                 no restating the question, no "let me look that up" deflection
//   conciseness — factual answers stay tight (word budget per case)
//   accuracy    — correct route (routing SSE event) + reply contains the expected
//                 fact, or is grounded in what the tool actually returned
//   speed       — TTFB and total wall time per turn
//
// Mints a temporary admin session (same pattern as chat-e2e.ts) and deletes it
// plus every conversation it created on exit.
//
// Usage:
//   bun run scripts/eval/companion-eval.ts                 # default assistant
//   bun run scripts/eval/companion-eval.ts --character     # first companion character
//   bun run scripts/eval/companion-eval.ts --only tom-cruise-latest
//   bun run scripts/eval/companion-eval.ts --json out.json
import { randomBytes } from 'node:crypto'
import { db } from '@/db'
import { sessions, users, characters } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { hashSessionToken } from '@/lib/session'

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000'
const useCharacter = process.argv.includes('--character')
const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null
const jsonIdx = process.argv.indexOf('--json')
const jsonPath = jsonIdx !== -1 ? process.argv[jsonIdx + 1] : null

interface TestCase {
  id: string
  prompt: string
  /** Tool ids that count as a correct route; [] = expect NO tool (conversational). */
  expectRoute: string[]
  /** Reply must match (accuracy). Omit to use grounding (reply overlaps tool data). */
  expectContent?: RegExp
  /** When true, accuracy = reply shares topical tokens with the tool's answer_payload. */
  grounded?: boolean
  /** Conciseness budget in words (default 80). */
  maxWords?: number
}

const CASES: TestCase[] = [
  // Fresh-info lookups — must route to search and answer from live data, directly.
  { id: 'tom-cruise-latest', prompt: 'what is the latest tom cruise movie', expectRoute: ['search'], grounded: true, maxWords: 70 },
  { id: 'fresh-champion', prompt: 'who won the super bowl this year', expectRoute: ['search', 'sports'], grounded: true, maxWords: 60 },
  { id: 'person-lookup', prompt: 'who is the ceo of nvidia', expectRoute: ['search'], expectContent: /jensen|huang/i, maxWords: 60 },
  // Deterministic tools — exact answers, tiny word budgets.
  { id: 'math-mult', prompt: 'what is 17 times 23', expectRoute: ['calculator'], expectContent: /391/, maxWords: 30 },
  { id: 'math-tip', prompt: 'how much is a 20% tip on $85', expectRoute: ['calculator'], expectContent: /\$?\s?17|seventeen/i, maxWords: 40 },
  { id: 'unit-convert', prompt: 'how many kilometers is 5 miles', expectRoute: ['unit_conversion'], expectContent: /8(\.0?\d?)?\s?(k|km|kilometer)/i, maxWords: 30 },
  { id: 'define-word', prompt: 'what does ephemeral mean', expectRoute: ['dictionary'], expectContent: /short|brief|lasting|transient|fleeting/i, maxWords: 60 },
  // Weekday computed at runtime — a hardcoded day is only right one day a week.
  { id: 'day-today', prompt: 'what day is it today', expectRoute: ['datetime'], expectContent: new RegExp(new Date().toLocaleDateString('en-US', { weekday: 'long' }), 'i'), maxWords: 30 },
  // Weather (route + shape; content depends on configured location).
  { id: 'weather-today', prompt: "what's the weather like today", expectRoute: ['weather'], expectContent: /\d+\s?°|\bdegrees\b/i, maxWords: 70 },
  // Conversational — must NOT route to a tool, and a greeting back is fine here.
  { id: 'chitchat', prompt: "hey, how's it going", expectRoute: [], maxWords: 60 },
]

// ── Directness heuristics ─────────────────────────────────────────────────────
// A reply is INDIRECT when it front-loads social filler before the answer:
// greetings, time-of-day acknowledgements, restating the ask, or deflection.
const OPENER_WINDOW = 90 // chars — padding must appear near the start to count

function directnessIssues(reply: string, prompt: string, isChitchat: boolean): string[] {
  const issues: string[] = []
  const head = reply.slice(0, OPENER_WINDOW).trim()
  if (!isChitchat) {
    if (/^(hi|hey|hello|greetings|howdy|good (morning|afternoon|evening|day))\b/i.test(head)) {
      issues.push('greeting-preamble')
    }
    if (/(good (morning|afternoon|evening)|up (so |this )?late|early bird|this (\w+ )?hour|this time of (day|night)|burning the midnight|\d{1,2}:\d{2}\s*(a\.?m\.?|p\.?m\.?)?|wide awake|middle of the night|late at night|\b\d{1,2}\s*(a\.?m\.?|p\.?m\.?)\b)/i.test(head)) {
      issues.push('time-acknowledgement')
    }
    // Transition filler before the answer ("alright, let's get to your question").
    if (/(let'?s get to (your|the|it)|to answer your question|since you'?re (already )?up|now,? (about|onto) (your|that)|glad you asked|great question|good question|i'?m thinking\.{2,})/i.test(head)) {
      issues.push('transition-filler')
    }
    // Restating the ask: opener echoes most of the prompt's topical words, or uses
    // an explicit "you're asking/wondering" frame.
    if (/\byou(?:'re| are)? (asking|wondering|curious|want to know|lookin'?g? to|want(ing)? to|trying to)\b/i.test(head)) {
      issues.push('restates-question')
    } else {
      const promptTokens = [...new Set((prompt.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length >= 4))]
      if (promptTokens.length >= 2) {
        const firstSentence = (reply.match(/^[^.!?\n]{0,120}[.!?]?/) ?? [''])[0].toLowerCase()
        const echoed = promptTokens.filter(t => firstSentence.includes(t)).length
        // Echoing every topical token in an interrogative/echo first sentence = restating.
        if (echoed === promptTokens.length && /\?\s*$/.test(firstSentence.trim())) {
          issues.push('restates-question')
        }
      }
    }
    if (/^(let me|i'?ll|i can|i could|give me a (sec|moment)|one (sec|moment)|hold on|hmm+,? let)/i.test(head) && /\b(look|check|see|find|search|dig)\b/i.test(head)) {
      issues.push('deflects-instead-of-answering')
    }
    if (/\b(would you like me to|do you want me to|should i) (look|check|search|find)/i.test(reply)) {
      issues.push('asks-permission-to-answer')
    }
  }
  return issues
}

// Grounding: the reply should reuse topical tokens from what the tool returned.
function isGrounded(reply: string, toolData: unknown): boolean {
  const payload = (toolData as { answer_payload?: { gist?: string; highlights?: string[] } } | null)?.answer_payload
  const src = [payload?.gist ?? '', ...(payload?.highlights ?? [])].join(' ')
  const tokens = [...new Set((src.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length >= 5))]
  if (tokens.length === 0) return false
  const r = reply.toLowerCase()
  const hits = tokens.filter(t => r.includes(t)).length
  return hits >= Math.min(2, tokens.length)
}

// ── Session setup ─────────────────────────────────────────────────────────────
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

let characterId: string | undefined
if (useCharacter) {
  const rows = await db.select({ id: characters.id, name: characters.name }).from(characters)
  characterId = rows[0]?.id
  if (characterId) console.log(`character: ${rows[0]!.name}`)
}

const createdConvs: string[] = []

interface RunResult {
  id: string
  prompt: string
  routedTools: string[]
  reply: string
  routeOk: boolean
  accuracyOk: boolean
  directnessIssues: string[]
  words: number
  conciseOk: boolean
  ttfbMs: number
  totalMs: number
  error?: string
}

async function runCase(tc: TestCase): Promise<RunResult> {
  const start = performance.now()
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `session=${token}` },
    body: JSON.stringify({ message: tc.prompt, characterId }),
  })
  const base: Omit<RunResult, 'routeOk' | 'accuracyOk' | 'directnessIssues' | 'words' | 'conciseOk'> = {
    id: tc.id, prompt: tc.prompt, routedTools: [], reply: '', ttfbMs: 0, totalMs: 0,
  }
  if (!res.ok || !res.body) {
    return { ...base, routeOk: false, accuracyOk: false, directnessIssues: [], words: 0, conciseOk: false, totalMs: Math.round(performance.now() - start), error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
  }

  const routedTools: string[] = []
  let reply = ''
  let ttfbMs = 0
  let toolData: unknown = null
  let errMsg: string | undefined
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
      // Strip only \r — token data can carry meaningful trailing spaces (the
      // profanity stream buffer emits word-boundary chunks like "word "), and
      // trimEnd() was squishing character-mode replies into one giant word.
      let line = buf.slice(0, nl)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      buf = buf.slice(nl + 1)
      if (line.startsWith('event:')) curEvent = line.slice(6).trim()
      else if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '')
        if (curEvent === 'token') {
          if (!ttfbMs) ttfbMs = Math.round(performance.now() - start)
          try { reply += (JSON.parse(data) as { text?: string })?.text ?? data } catch { reply += data }
        } else if (curEvent === 'routing') {
          try { routedTools.push((JSON.parse(data) as { tool: string }).tool) } catch { /* ignore */ }
        } else if (curEvent === 'tool_data') {
          try { toolData = (JSON.parse(data) as { data: unknown }).data } catch { /* ignore */ }
        } else if (curEvent === 'error') {
          errMsg = data.slice(0, 200)
        } else if (curEvent === 'done') {
          try {
            const d = JSON.parse(data) as { conversationId?: string }
            if (d.conversationId) createdConvs.push(d.conversationId)
          } catch { /* ignore */ }
          break outer
        }
      }
    }
  }
  const totalMs = Math.round(performance.now() - start)

  const routeOk = tc.expectRoute.length === 0
    ? routedTools.length === 0
    : routedTools.some(t => tc.expectRoute.includes(t))
  const contentOk = tc.expectContent
    ? tc.expectContent.test(reply)
    : tc.grounded
      ? isGrounded(reply, toolData)
      : reply.trim().length > 0
  const accuracyOk = routeOk && contentOk && !errMsg
  const issues = directnessIssues(reply, tc.prompt, tc.expectRoute.length === 0)
  const words = (reply.trim().match(/\S+/g) ?? []).length
  const conciseOk = words > 0 && words <= (tc.maxWords ?? 80)

  return { ...base, routedTools, reply, routeOk, accuracyOk, directnessIssues: issues, words, conciseOk, ttfbMs, totalMs, error: errMsg }
}

const results: RunResult[] = []
try {
  for (const tc of CASES) {
    if (only && tc.id !== only) continue
    const r = await runCase(tc)
    results.push(r)
    const pass = r.accuracyOk && r.directnessIssues.length === 0 && r.conciseOk
    console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${r.id}`)
    console.log(`  prompt : ${r.prompt}`)
    console.log(`  route  : [${r.routedTools.join(', ') || 'none'}] ${r.routeOk ? 'ok' : `WRONG (want ${tc.expectRoute.join('|') || 'none'})`}`)
    console.log(`  reply  : ${r.reply.replace(/\s+/g, ' ').slice(0, 300)}`)
    console.log(`  grade  : accuracy=${r.accuracyOk ? 'ok' : 'FAIL'} direct=${r.directnessIssues.length === 0 ? 'ok' : r.directnessIssues.join(',')} concise=${r.conciseOk ? `ok (${r.words}w)` : `FAIL (${r.words}w > ${tc.maxWords ?? 80})`} speed=ttfb ${r.ttfbMs}ms / total ${r.totalMs}ms`)
    if (r.error) console.log(`  error  : ${r.error}`)
  }

  const passed = results.filter(r => r.accuracyOk && r.directnessIssues.length === 0 && r.conciseOk).length
  console.log(`\n══ ${passed}/${results.length} passed ══`)
  console.log(`accuracy: ${results.filter(r => r.accuracyOk).length}/${results.length}  direct: ${results.filter(r => r.directnessIssues.length === 0).length}/${results.length}  concise: ${results.filter(r => r.conciseOk).length}/${results.length}`)
  const ttfbs = results.map(r => r.ttfbMs).filter(Boolean).sort((a, b) => a - b)
  if (ttfbs.length) console.log(`speed: ttfb p50=${ttfbs[Math.floor(ttfbs.length / 2)]}ms max=${ttfbs.at(-1)}ms`)
  if (jsonPath) await Bun.write(jsonPath, JSON.stringify(results, null, 2))
} finally {
  for (const id of createdConvs) {
    await fetch(`${BASE}/api/chat/conversations/${id}`, { method: 'DELETE', headers: { cookie: `session=${token}` } }).catch(() => {})
  }
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}
process.exit(0)
