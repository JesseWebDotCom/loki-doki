import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { users } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import {
  CONTENT_CATEGORIES, DIAL_LEVELS, MAX_DIALS,
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  getDefaultProfileSlug, setDefaultProfileSlug,
  getUserProfileSlug, setUserProfileSlug, unrestrictedCategories,
} from '@/lib/contentPolicy'
import type { AppEnv } from '@/types'

const adminContent = new Hono<AppEnv>()

// Category metadata for the admin UI (axes, levels, labels).
adminContent.get('/categories', requireAdmin, (c) => {
  return c.json({
    categories: CONTENT_CATEGORIES.map((cat) => ({
      key: cat.key, label: cat.label, help: cat.help,
      levels: cat.levels.map((l) => ({ value: l.value, label: l.label })),
    })),
    levels: DIAL_LEVELS, max: MAX_DIALS,
  })
})

// ── Profiles ───────────────────────────────────────────────────────────────────
adminContent.get('/profiles', requireAdmin, async (c) => {
  const [profiles, defaultSlug] = await Promise.all([listProfiles(), getDefaultProfileSlug()])
  return c.json({ profiles, defaultSlug })
})

adminContent.post('/profiles', requireAdmin, async (c) => {
  const body = (await c.req.json()) as { name?: string; description?: string; dials?: Record<string, unknown>; kidSafeMedia?: boolean }
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const profile = await createProfile(body.name, body.description ?? '', body.dials ?? {}, body.kidSafeMedia === true)
  return c.json({ ok: true, profile })
})

adminContent.put('/profiles/:slug', requireAdmin, async (c) => {
  const slug = c.req.param('slug')
  const body = (await c.req.json()) as { name?: string; description?: string; dials?: Record<string, unknown>; kidSafeMedia?: boolean }
  const profile = await updateProfile(slug, body)
  if (!profile) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true, profile })
})

adminContent.delete('/profiles/:slug', requireAdmin, async (c) => {
  const res = await deleteProfile(c.req.param('slug'))
  if (!res.ok) return c.json({ error: res.error }, 400)
  return c.json({ ok: true })
})

adminContent.put('/default-profile', requireAdmin, async (c) => {
  const { slug } = (await c.req.json()) as { slug?: string }
  if (!slug || !(await getProfile(slug))) return c.json({ error: 'unknown profile' }, 400)
  await setDefaultProfileSlug(slug)
  return c.json({ ok: true, defaultSlug: slug })
})

// ── Per-user assignment ──────────────────────────────────────────────────────────
adminContent.get('/users/:userId/profile', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1)
  if (!u) return c.json({ error: 'User not found' }, 404)
  return c.json({ slug: await getUserProfileSlug(userId) })
})

adminContent.put('/users/:userId/profile', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1)
  if (!u) return c.json({ error: 'User not found' }, 404)
  const { slug } = (await c.req.json()) as { slug?: string }
  const profile = slug ? await getProfile(slug) : null
  if (!profile) return c.json({ error: 'unknown profile' }, 400)
  await setUserProfileSlug(userId, slug!)
  // Surface which categories this assignment opens to 100%, so the UI can warn.
  return c.json({ ok: true, slug, unrestricted: unrestrictedCategories(profile.dials) })
})

export { adminContent }
