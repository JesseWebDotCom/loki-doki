// Learned-methods API: list (own + household) and delete. Methods are authored
// conversationally via the save_method tool and recalled into the companion prompt
// by lib/methods/recall; this route is the management surface.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { deleteMethod, listMethods } from '@/lib/methods/recall'

const app = new Hono<AppEnv>()

app.use('*', requireAuth)

// GET /api/methods — the user's own methods plus household-wide ones.
app.get('/', async (c) => {
  const user = c.get('user')
  const rows = await listMethods(user.id)
  const serialized = rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      steps: r.steps,
      scope: r.userId === null ? ('household' as const) : ('personal' as const),
      uses: r.uses,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
      canDelete: r.userId === user.id || (r.userId === null && user.role === 'admin'),
    }))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
  return c.json({ methods: serialized })
})

// DELETE /api/methods/:id — own methods (any user) or household methods (admin only).
app.delete('/:id', async (c) => {
  const user = c.get('user')
  const ok = await deleteMethod(c.req.param('id'), user.id, user.role === 'admin')
  return ok ? c.json({ ok: true }) : c.json({ ok: false, error: 'Not found or not yours to delete.' }, 404)
})

export default app
