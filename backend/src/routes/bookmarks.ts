import { Hono } from 'hono'
import { eq, or, isNull, and } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarks, userPreferences } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { safeFetch } from '@/lib/ssrfGuard'
import type { AppEnv } from '@/types'

const bookmarksRouter = new Hono<AppEnv>()

// ── Probe: check reachability + frame-blocking headers + favicon ──────────────
// Must be registered before /:id so "probe" is not treated as an id.

bookmarksRouter.get('/probe', requireAuth, async (c) => {
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'url required' }, 400)

  let parsed: URL
  try { parsed = new URL(url) } catch { return c.json({ error: 'Invalid URL' }, 400) }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return c.json({ error: 'Only http/https URLs supported' }, 400)
  }

  try {
    // safeFetch validates the destination (and every redirect hop) against
    // internal/loopback/metadata ranges. A blocked URL throws and is reported
    // as unreachable by the catch below.
    const res = await safeFetch(url, {
      method: 'GET',
      headers: { accept: 'text/html,*/*', 'user-agent': 'Mozilla/5.0 (compatible)' },
    }, { timeoutMs: 8_000 })

    // Detect frame-blocking
    const xfo = res.headers.get('x-frame-options')
    const csp = res.headers.get('content-security-policy') ?? ''
    let framesBlocked = !!xfo
    if (!framesBlocked) {
      const fa = csp.match(/frame-ancestors\s+([^;]+)/i)
      if (fa) framesBlocked = !fa[1].includes('*')
    }

    // Extract favicon from HTML
    let faviconUrl: string | null = null
    const origin = new URL(url).origin
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('text/html')) {
      const html = await res.text()
      const m =
        html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i) ??
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i)
      if (m) {
        try { faviconUrl = new URL(m[1], origin).href } catch {}
      }
    }
    if (!faviconUrl) {
      try {
        const ico = await safeFetch(`${origin}/favicon.ico`, { method: 'HEAD' }, { timeoutMs: 3_000 })
        if (ico.ok) faviconUrl = `${origin}/favicon.ico`
      } catch {}
    }

    return c.json({ reachable: true, framesBlocked, faviconUrl })
  } catch {
    return c.json({ reachable: false, framesBlocked: false, faviconUrl: null })
  }
})

// ── List: global + personal, with hidden state ────────────────────────────────

bookmarksRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user')

  const hiddenPref = await db.select()
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, 'bookmarks.hidden')))
    .then(rows => rows[0])
  const hiddenIds: string[] = hiddenPref ? JSON.parse(hiddenPref.value) : []

  const rows = await db.select().from(bookmarks)
    .where(or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, user.id)))

  return c.json({
    bookmarks: rows.map(b => ({
      ...b,
      isGlobal: b.ownerId === null,
      canEdit: b.ownerId === user.id,
      isHidden: b.ownerId === null && hiddenIds.includes(b.id),
    })),
  })
})

// ── Create personal bookmark ──────────────────────────────────────────────────

bookmarksRouter.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ label: string; url: string; icon?: string; category?: string; useProxy?: boolean; useEmbed?: boolean }>()
  if (!body.label?.trim() || !body.url?.trim()) return c.json({ error: 'label and url required' }, 400)

  const now = new Date()
  const bookmark = {
    id: crypto.randomUUID(),
    ownerId: user.id,
    label: body.label.trim(),
    url: body.url.trim(),
    icon: body.icon ?? null,
    category: body.category?.trim() || 'Other',
    sortOrder: 0,
    useProxy: body.useProxy ?? false,
    useEmbed: body.useEmbed ?? false,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(bookmarks).values(bookmark)
  return c.json({ bookmark })
})

// ── Update own bookmark ───────────────────────────────────────────────────────

bookmarksRouter.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<Partial<{ label: string; url: string; icon: string; category: string; sortOrder: number; useProxy: boolean; useEmbed: boolean }>>()

  const existing = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), eq(bookmarks.ownerId, user.id)))
    .then(r => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.update(bookmarks)
    .set({
      label:     body.label     !== undefined ? body.label.trim()    : existing.label,
      url:       body.url       !== undefined ? body.url.trim()      : existing.url,
      icon:      body.icon      !== undefined ? body.icon            : existing.icon,
      category:  body.category  !== undefined ? body.category.trim() : existing.category,
      sortOrder: body.sortOrder !== undefined ? body.sortOrder       : existing.sortOrder,
      useProxy:  body.useProxy  !== undefined ? body.useProxy        : existing.useProxy,
      useEmbed:  body.useEmbed  !== undefined ? body.useEmbed        : existing.useEmbed,
      updatedAt: new Date(),
    })
    .where(eq(bookmarks.id, id))

  return c.json({ ok: true })
})

// ── Delete own bookmark ───────────────────────────────────────────────────────

bookmarksRouter.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const existing = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), eq(bookmarks.ownerId, user.id)))
    .then(r => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(bookmarks).where(eq(bookmarks.id, id))
  return c.json({ ok: true })
})

// ── Hide / unhide a global bookmark ──────────────────────────────────────────

bookmarksRouter.put('/hide/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const bm = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), isNull(bookmarks.ownerId)))
    .then(r => r[0])
  if (!bm) return c.json({ error: 'Not found' }, 404)

  const now = new Date()
  const existingPref = await db.select().from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, 'bookmarks.hidden')))
    .then(r => r[0])

  const current: string[] = existingPref ? JSON.parse(existingPref.value) : []
  if (!current.includes(id)) current.push(id)

  if (existingPref) {
    await db.update(userPreferences)
      .set({ value: JSON.stringify(current), updatedAt: now })
      .where(eq(userPreferences.id, existingPref.id))
  } else {
    await db.insert(userPreferences).values({
      id: crypto.randomUUID(),
      userId: user.id,
      key: 'bookmarks.hidden',
      value: JSON.stringify(current),
      updatedAt: now,
    })
  }

  return c.json({ ok: true })
})

bookmarksRouter.delete('/hide/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const existingPref = await db.select().from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, 'bookmarks.hidden')))
    .then(r => r[0])

  if (!existingPref) return c.json({ ok: true })

  const updated = (JSON.parse(existingPref.value) as string[]).filter(x => x !== id)
  await db.update(userPreferences)
    .set({ value: JSON.stringify(updated), updatedAt: new Date() })
    .where(eq(userPreferences.id, existingPref.id))

  return c.json({ ok: true })
})

export { bookmarksRouter as bookmarks }
