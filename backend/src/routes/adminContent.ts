import { Hono } from 'hono'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { users, videoAllowlist, videoFollows, ytSubscriptions } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import {
  CONTENT_CATEGORIES, DIAL_LEVELS, MAX_DIALS,
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  getDefaultProfileSlug, setDefaultProfileSlug,
  getUserProfileSlug, setUserProfileSlug, unrestrictedCategories,
  getUserPref, setUserPref,
} from '@/lib/contentPolicy'
import { ALLOWLIST_PREF, invalidateAllowlistCache } from '@/lib/videos/allowlist'
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

// ── Per-user video allowlist (approved-only mode) ─────────────────────────────────
// The strictest kid protection: when on, this user sees ONLY videos from the approved
// creators / the individually approved videos below. Enforced in lib/videos/policy.ts.

adminContent.get('/users/:userId/video-allowlist', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  if (!u) return c.json({ error: 'User not found' }, 404)
  const [enabled, entries] = await Promise.all([
    getUserPref(userId, ALLOWLIST_PREF),
    db.select().from(videoAllowlist).where(eq(videoAllowlist.userId, userId)).orderBy(asc(videoAllowlist.createdAt)),
  ])
  return c.json({ enabled: enabled === true, entries })
})

adminContent.put('/users/:userId/video-allowlist', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  if (!u) return c.json({ error: 'User not found' }, 404)
  const body = await c.req.json().catch(() => ({})) as { enabled?: boolean }
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled required' }, 400)
  await setUserPref(userId, ALLOWLIST_PREF, body.enabled)
  invalidateAllowlistCache(userId)
  return c.json({ ok: true, enabled: body.enabled })
})

adminContent.post('/users/:userId/video-allowlist/entries', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const body = await c.req.json().catch(() => ({})) as {
    source?: string; kind?: string; externalId?: string; title?: string; thumbnailUrl?: string
  }
  const source = (body.source ?? '').trim().slice(0, 20)
  const externalId = (body.externalId ?? '').trim().slice(0, 200)
  const kind = body.kind === 'video' ? 'video' as const : 'creator' as const
  if (!source || !externalId) return c.json({ error: 'source and externalId required' }, 400)
  await db.insert(videoAllowlist)
    .values({
      id: crypto.randomUUID(), userId, source, kind, externalId,
      title: body.title?.slice(0, 300) ?? null, thumbnailUrl: body.thumbnailUrl?.slice(0, 2000) ?? null,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
  invalidateAllowlistCache(userId)
  const entries = await db.select().from(videoAllowlist).where(eq(videoAllowlist.userId, userId)).orderBy(asc(videoAllowlist.createdAt))
  return c.json({ ok: true, entries })
})

adminContent.delete('/users/:userId/video-allowlist/entries/:entryId', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  await db.delete(videoAllowlist).where(and(
    eq(videoAllowlist.userId, userId), eq(videoAllowlist.id, c.req.param('entryId')),
  ))
  invalidateAllowlistCache(userId)
  return c.json({ ok: true })
})

// Approval candidates: every creator anyone in the household already follows (the natural
// pool parents pick from), deduped across users. YouTube channels + hub creators.
adminContent.get('/video-allowlist/candidates', requireAdmin, async (c) => {
  const [yt, hub] = await Promise.all([
    db.select({
      externalId: ytSubscriptions.externalId, title: ytSubscriptions.title, thumbnailUrl: ytSubscriptions.thumbnailUrl,
    }).from(ytSubscriptions).where(eq(ytSubscriptions.kind, 'channel')),
    db.select({
      source: videoFollows.source, externalId: videoFollows.externalId,
      title: videoFollows.title, thumbnailUrl: videoFollows.thumbnailUrl,
    }).from(videoFollows),
  ])
  const seen = new Set<string>()
  const candidates: Array<{ source: string; externalId: string; title: string; thumbnailUrl: string | null }> = []
  for (const s of yt) {
    const key = `youtube:${s.externalId.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ source: 'youtube', externalId: s.externalId, title: s.title || s.externalId, thumbnailUrl: s.thumbnailUrl })
  }
  for (const f of hub) {
    const key = `${f.source}:${f.externalId.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ source: f.source, externalId: f.externalId, title: f.title || f.externalId, thumbnailUrl: f.thumbnailUrl })
  }
  candidates.sort((a, b) => a.title.localeCompare(b.title))
  return c.json({ candidates })
})

export { adminContent }
