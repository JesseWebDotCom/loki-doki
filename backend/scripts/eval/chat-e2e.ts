// End-to-end chat latency probe — drives the REAL /api/chat/stream route the
// way the frontend does, and reports TTFB (first visible token), route/tool
// phase timings from SSE events, and total wall time.
//
// Mints a temporary admin session directly in the DB and deletes it on exit.
//
// Usage: bun run scripts/eval/chat-e2e.ts ["message"] [--runs N] [--character]
import { randomBytes } from 'node:crypto'
import { db } from '@/db'
import { sessions, users, characters } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { hashSessionToken } from '@/lib/session'

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000'
const runsIdx = process.argv.indexOf('--runs')
const RUNS = runsIdx !== -1 ? Number(process.argv[runsIdx + 1]) : 1
const useCharacter = process.argv.includes('--character')
const message = process.argv.find((a, i) => i >= 2 && !a.startsWith('--') && process.argv[i - 1] !== '--runs')
  ?? 'hey, how has your day been?'

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
const cleanup = async () => { await db.delete(sessions).where(eq(sessions.id, sessionId)) }

let characterId: string | undefined
if (useCharacter) {
  const charIdx = process.argv.indexOf('--character')
  const wantName = process.argv[charIdx + 1]?.startsWith('--') ? undefined : process.argv[charIdx + 1]
  const rows = await db.select({ id: characters.id, name: characters.name }).from(characters)
  characterId = (wantName ? rows.find(r => r.name.toLowerCase() === wantName.toLowerCase()) : rows[0])?.id
}

try {
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now()
    const res = await fetch(`${BASE}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `session=${token}` },
      body: JSON.stringify({ message, characterId }),
    })
    if (!res.ok || !res.body) {
      console.log(`run ${run}: HTTP ${res.status} ${await res.text()}`)
      continue
    }

    const headerMs = Math.round(performance.now() - start)
    let ttfbMs = 0
    let tokens = 0
    let chars = 0
    const events: Array<{ event: string; ms: number; note?: string }> = []
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
        const line = buf.slice(0, nl).trimEnd()
        buf = buf.slice(nl + 1)
        if (line.startsWith('event:')) curEvent = line.slice(6).trim()
        else if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          const ms = Math.round(performance.now() - start)
          if (curEvent === 'token' || curEvent === 'delta' || curEvent === 'text' || curEvent === 'message') {
            tokens++
            try { chars += (JSON.parse(data)?.text ?? JSON.parse(data)?.token ?? '').length } catch { chars += data.length }
            if (!ttfbMs) { ttfbMs = ms; events.push({ event: `first-${curEvent}`, ms }) }
          } else if (curEvent && curEvent !== 'ping') {
            events.push({ event: curEvent, ms, note: data.slice(0, 120) })
            if (curEvent === 'done' || curEvent === 'error') { break }
          }
        }
      }
    }
    const totalMs = Math.round(performance.now() - start)
    console.log(`\nrun ${run}: msg="${message}"${characterId ? ' (character)' : ''}`)
    console.log(`  headers:${headerMs}ms  first-token:${ttfbMs}ms  total:${totalMs}ms  tokens:${tokens} (${chars} chars)`)
    for (const e of events) console.log(`  [${String(e.ms).padStart(6)}ms] ${e.event}${e.note ? ' ' + e.note : ''}`)

    // Pull server-side stage timings for this turn from the log ring buffer
    try {
      const logRes = await fetch(`${BASE}/api/logs/recent`, { headers: { cookie: `session=${token}` } })
      if (logRes.ok) {
        const data = await logRes.json() as { entries?: Array<{ msg?: string }> }
        const lines = (data.entries ?? [])
          .map(l => l.msg ?? JSON.stringify(l))
          .filter(l => /CHAT-TIMING|OLLAMA-TCP|\[ROUTER\]/.test(l))
          .slice(-25)
        console.log('  server stages:')
        for (const l of lines) console.log(`    ${l}`)
      }
    } catch { /* log fetch is best-effort */ }
  }
} finally {
  await cleanup()
}
process.exit(0)
