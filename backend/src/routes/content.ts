import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getCeiling, getUserAdminCeiling, effectiveCeiling, DIAL_LEVELS } from '@/lib/contentPolicy'
import type { AppEnv } from '@/types'

const content = new Hono<AppEnv>()

// The effective ceiling for THIS user = stricter of the instance ceiling and their
// admin-set personal cap, so the settings UI only offers levels they're actually allowed
// to pick (a capped child sees only the lowest level on every dial).
content.get('/ceiling', requireAuth, async (c) => {
  const user = c.get('user')
  const [global, adminCap] = await Promise.all([getCeiling(), getUserAdminCeiling(user.id, user.role)])
  return c.json({ ceiling: effectiveCeiling(global, adminCap), levels: DIAL_LEVELS })
})

export { content }
