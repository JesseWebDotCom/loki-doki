import { Hono } from 'hono'
import type { Context } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { parseSkill } from '@/lib/skills/parse'
import {
  readUserSkillFile, writeUserSkillFile, deleteUserSkillFile, invalidate,
} from '@/lib/skills/registry'
import { skillStates, setSkillEnabled } from '@/lib/skills/resolver'

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

// ── User-facing skills (own catalog + authoring) ────────────────────────────────
const skillsRoute = new Hono<AppEnv>()

skillsRoute.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  return c.json({ skills: await skillStates(user.id) })
})

skillsRoute.post('/refresh', requireAuth, async (c) => {
  const user = c.get('user')
  invalidate(user.id)
  return c.json({ skills: await skillStates(user.id) })
})

// Toggle a skill on/off for the current user.
skillsRoute.post('/:name', requireAuth, async (c) => {
  const user = c.get('user')
  const name = c.req.param('name')
  if (!NAME_RE.test(name)) return c.json({ error: 'Invalid skill name' }, 400)
  const body = await c.req.json().catch(() => ({})) as { enabled?: unknown }
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400)
  await setSkillEnabled(user.id, name, body.enabled, 'user_toggle')
  return c.json({ skills: await skillStates(user.id) })
})

// Raw markdown of a personal skill file (for the editor).
skillsRoute.get('/:name/file', requireAuth, async (c) => {
  const user = c.get('user')
  const md = readUserSkillFile(user.id, c.req.param('name'))
  if (md === null) return c.json({ error: 'skill_file_not_found' }, 404)
  return c.json({ markdown: md })
})

async function upsertFile(c: Context<AppEnv>, mode: 'create' | 'update') {
  const user = c.get('user')
  const name = c.req.param('name')
  if (!NAME_RE.test(name)) return c.json({ error: 'Invalid skill name' }, 400)
  const body = await c.req.json().catch(() => ({})) as { markdown?: unknown }
  if (typeof body.markdown !== 'string') return c.json({ error: 'markdown required' }, 400)

  const parsed = parseSkill(body.markdown)
  if (!parsed.ok) return c.json({ error: parsed.error.message, kind: parsed.error.kind, line: parsed.error.line }, 400)
  if (parsed.skill.name !== name) return c.json({ error: 'name_mismatch', kind: 'invalid_name', line: null }, 400)

  const res = writeUserSkillFile(user.id, name, body.markdown, mode)
  if (!res.ok) {
    const status = res.error === 'exists' ? 409 : res.error === 'not_found' ? 404 : 400
    return c.json({ error: res.error }, status)
  }
  return c.json({ skills: await skillStates(user.id) })
}

skillsRoute.post('/:name/file', requireAuth, (c) => upsertFile(c, 'create'))
skillsRoute.put('/:name/file', requireAuth, (c) => upsertFile(c, 'update'))

skillsRoute.delete('/:name/file', requireAuth, async (c) => {
  const user = c.get('user')
  const res = deleteUserSkillFile(user.id, c.req.param('name'))
  if (!res.ok) return c.json({ error: res.error }, res.error === 'not_found' ? 404 : 400)
  return c.json({ skills: await skillStates(user.id) })
})

// ── Admin assignment (toggle on behalf of a user) ───────────────────────────────
const adminSkillsRoute = new Hono<AppEnv>()

adminSkillsRoute.get('/:userId/skills', requireAdmin, async (c) => {
  return c.json({ skills: await skillStates(c.req.param('userId')) })
})

adminSkillsRoute.post('/:userId/skills/:name', requireAdmin, async (c) => {
  const targetId = c.req.param('userId')
  const name = c.req.param('name')
  if (!NAME_RE.test(name)) return c.json({ error: 'Invalid skill name' }, 400)
  const body = await c.req.json().catch(() => ({})) as { enabled?: unknown }
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400)
  await setSkillEnabled(targetId, name, body.enabled, 'admin_assign')
  return c.json({ skills: await skillStates(targetId) })
})

export { skillsRoute, adminSkillsRoute }
