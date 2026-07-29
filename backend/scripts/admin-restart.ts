// Restart the prod backend through POST /api/admin/server/restart (the launcher's
// supervise loop respawns it). Mints a temporary admin session directly in the DB
// (same pattern as scripts/eval/chat-e2e.ts) and deletes it before the exit lands.
//
// Usage: bun run scripts/admin-restart.ts
import { randomBytes } from 'node:crypto'
import { db } from '@/db'
import { sessions, users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { hashSessionToken } from '@/lib/session'

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000'

const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1)
if (!admin) throw new Error('no admin user')

const token = randomBytes(32).toString('hex')
const sessionId = crypto.randomUUID()
await db.insert(sessions).values({
  id: sessionId,
  userId: admin.id,
  tokenHash: hashSessionToken(token),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  createdAt: new Date(),
})

try {
  const res = await fetch(`${BASE}/api/admin/server/restart`, {
    method: 'POST',
    headers: { cookie: `session=${token}` },
  })
  if (!res.ok) throw new Error(`restart returned ${res.status}: ${await res.text()}`)
  // SSE body: read to the end so the server has flushed 'done' before we start polling.
  console.log((await res.text()).trim())
} finally {
  // Direct DB write, so this works even while the backend is down.
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}

// The server exits ~1.5s after 'done'; poll until the supervisor has it back up.
const deadline = Date.now() + 120_000
await new Promise((r) => setTimeout(r, 3_000))
for (;;) {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2_000) })
    if (r.ok) break
  } catch { /* still coming up */ }
  if (Date.now() > deadline) throw new Error('backend did not come back within 120s')
  await new Promise((r) => setTimeout(r, 1_500))
}
console.log('backend is back up')
