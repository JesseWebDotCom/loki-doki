import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { emitNotification } from '@/lib/notify'
import type { AppEnv } from '@/types'

const appStore = new Hono<AppEnv>()

// ── POST /api/app-store/request ───────────────────────────────────────────────
// Any authenticated user can request an app/extension. Creates an install_request
// notification visible to admins (userId=null means admin-targeted).

appStore.post('/request', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json() as { toolId: string; toolName: string; message?: string }
  if (!body.toolId || !body.toolName) return c.json({ error: 'toolId and toolName are required' }, 400)

  const id = await emitNotification({
    type: 'install_request',
    userId: null,
    title: 'App install requested',
    body: `${user.firstName} asked for ${body.toolName}`,
    url: '/admin/apps',
    payload: {
      requestedBy: user.id,
      requestedByName: user.firstName,
      toolId: body.toolId,
      toolName: body.toolName,
      message: body.message ?? '',
    },
  })
  return c.json({ ok: true, id })
})

export { appStore }
