import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { getConsents, setConsents, CONSENT_DEFINITIONS, CONSENT_VERSION } from '@/lib/consent'
import type { AppEnv } from '@/types'

const consent = new Hono<AppEnv>()

interface ConsentBody {
  uncensored?: boolean
  internet?: boolean
  companions?: boolean
  liability?: boolean
  accept?: boolean
}

// Only the four known boolean keys are ever applied — never trust the body shape.
function pickPatch(body: ConsentBody) {
  const patch: { uncensored?: boolean; internet?: boolean; companions?: boolean; liability?: boolean } = {}
  if (typeof body.uncensored === 'boolean') patch.uncensored = body.uncensored
  if (typeof body.internet === 'boolean') patch.internet = body.internet
  if (typeof body.companions === 'boolean') patch.companions = body.companions
  if (typeof body.liability === 'boolean') patch.liability = body.liability
  return patch
}

// ── Self ────────────────────────────────────────────────────────────────────────

consent.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const consents = await getConsents(user.id)
  return c.json({ consents, definitions: CONSENT_DEFINITIONS, version: CONSENT_VERSION })
})

consent.put('/', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as ConsentBody
  const consents = await setConsents(user.id, pickPatch(body), { accept: body.accept === true })
  return c.json({ consents })
})

// ── Admin (edit another user's consents) ──────────────────────────────────────────

consent.get('/admin/:userId', requireAdmin, async (c) => {
  const consents = await getConsents(c.req.param('userId'))
  return c.json({ consents, definitions: CONSENT_DEFINITIONS, version: CONSENT_VERSION })
})

consent.put('/admin/:userId', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ConsentBody
  const consents = await setConsents(c.req.param('userId'), pickPatch(body), { accept: body.accept === true })
  return c.json({ consents })
})

export { consent }
