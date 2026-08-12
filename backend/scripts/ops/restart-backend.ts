// Ops: restart the running backend so it picks up the current working tree, then
// wait for it to come back. Mints a short-lived admin session (same pattern as
// scripts/eval/*) and POSTs the documented restart endpoint; the run supervisor
// respawns the process. On Windows the coding/host-shell PTY sidecar is spared by
// the restart path, so terminal sessions (including Claude Code) survive this.
//
// Usage (from backend/): bun run scripts/ops/restart-backend.ts
import { randomBytes } from 'node:crypto'
import { db } from '@/db'
import { sessions, users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { hashSessionToken } from '@/lib/session'

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000'
const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1)
if (!admin) throw new Error('no admin user')

const token = randomBytes(32).toString('hex')
await db.insert(sessions).values({
  id: crypto.randomUUID(),
  userId: admin.id,
  tokenHash: hashSessionToken(token),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  createdAt: new Date(),
})

console.log('restarting backend...')
try {
  const res = await fetch(`${BASE}/api/admin/server/restart`, { method: 'POST', headers: { cookie: `session=${token}` } })
  console.log('restart response:', res.status)
  try { await res.text() } catch { /* stream drops when the process exits */ }
} catch (e) {
  console.log('restart request ended:', e instanceof Error ? e.message : String(e))
}

await new Promise((r) => setTimeout(r, 5000))
const deadline = Date.now() + 240_000
let ready = false
while (Date.now() < deadline) {
  try {
    const h = await fetch(`${BASE}/api/system/ready`, { signal: AbortSignal.timeout(2000) })
    if (h.ok) { ready = true; break }
  } catch { /* still down */ }
  await new Promise((r) => setTimeout(r, 3000))
}
console.log(ready ? 'backend is back up and ready' : 'TIMEOUT: backend not ready within 4 minutes')
process.exit(ready ? 0 : 1)
