// Plex API for the Shows + Movies apps. All endpoints degrade gracefully to "not
// configured / not present" when no Plex server is set up, so the frontend can always call
// them and just hide the Plex affordances when absent.

import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import {
  getPlexConnection,
  plexStatus,
  findInPlex,
  recentlyAdded,
  onDeck,
  hubs,
  sessions,
  fetchPlexImage,
  addToPlexWatchlist,
  getPlayback,
  streamPart,
} from '@/lib/plex'
import { getUserPlexConnection, isUserPlexLinked, isPlexServerConfigured, setUserPlexToken } from '@/lib/plex/account'
import { plexItemsToPosters } from '@/lib/plex/resolve'
import { createPlexPin, checkPlexPin, discoverPlexServers } from '@/lib/plex/auth'
import { savePlexConfig, getPlexConfigSummary } from '@/lib/plex/config'
import type { AppEnv } from '@/types'

const plexRoute = new Hono<AppEnv>()
plexRoute.use('*', requireAuth)

plexRoute.get('/status', async (c) => {
  const user = c.get('user')
  const conn = await getUserPlexConnection(user.id)
  if (!conn) {
    const serverConfigured = await isPlexServerConfigured()
    return c.json({ configured: false, ok: false, serverName: null, linked: false, serverConfigured })
  }
  const [status, linked] = await Promise.all([plexStatus(conn), isUserPlexLinked(user.id)])
  return c.json({ configured: true, ...status, linked, serverConfigured: true })
})

plexRoute.get('/find', async (c) => {
  const conn = await getUserPlexConnection(c.get('user').id)
  const type = c.req.query('type') === 'movie' ? 'movie' : 'show'
  const title = c.req.query('title')?.trim()
  if (!conn || !title) {
    return c.json({ present: false, ratingKey: null, title: null, year: null, type: null, deepLink: null, guids: [] })
  }
  const yearRaw = c.req.query('year')
  const tvdbRaw = c.req.query('tvdb')
  const match = await findInPlex(conn, {
    type,
    title,
    year: yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
    imdb: c.req.query('imdb') ?? null,
    tvdb: tvdbRaw && /^\d+$/.test(tvdbRaw) ? Number(tvdbRaw) : null,
  })
  return c.json(match)
})

// ── library rails (resolved to clickable poster cards) ───────────────────────────

function typeFilter(c: { req: { query: (k: string) => string | undefined } }): 'movie' | 'show' | null {
  const t = c.req.query('type')
  return t === 'movie' ? 'movie' : t === 'show' ? 'show' : null
}

plexRoute.get('/recent', async (c) => {
  const conn = await getUserPlexConnection(c.get('user').id)
  if (!conn) return c.json({ items: [] })
  const want = typeFilter(c)
  const posters = await plexItemsToPosters(await recentlyAdded(conn, 40))
  return c.json({ items: want ? posters.filter((p) => p.mediaType === want) : posters })
})

plexRoute.get('/ondeck', async (c) => {
  const conn = await getUserPlexConnection(c.get('user').id)
  if (!conn) return c.json({ items: [] })
  const want = typeFilter(c)
  const posters = await plexItemsToPosters(await onDeck(conn, 30))
  return c.json({ items: want ? posters.filter((p) => p.mediaType === want) : posters })
})

plexRoute.get('/hubs', async (c) => {
  const conn = await getUserPlexConnection(c.get('user').id)
  if (!conn) return c.json({ items: [] })
  const want = typeFilter(c)
  const posters = await plexItemsToPosters(await hubs(conn, 40))
  return c.json({ items: want ? posters.filter((p) => p.mediaType === want) : posters })
})

plexRoute.get('/sessions', async (c) => {
  const conn = await getUserPlexConnection(c.get('user').id)
  if (!conn) return c.json({ sessions: [] })
  return c.json({ sessions: await sessions(conn) })
})

// ── token-stripping image proxy ──────────────────────────────────────────────────

plexRoute.get('/img', async (c) => {
  const conn = await getUserPlexConnection(c.get('user').id)
  const path = c.req.query('path')
  if (!conn || !path || !path.startsWith('/')) return c.json({ error: 'path is required' }, 400)
  // Only ever proxy library art — never let an arbitrary server path through with the token.
  if (!/^\/(library|photo)\//.test(path)) return c.json({ error: 'forbidden' }, 403)
  const img = await fetchPlexImage(conn, path)
  if (!img) return c.json({ error: 'Image unavailable' }, 404)
  return new Response(new Uint8Array(img.data), {
    headers: { 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=86400' },
  })
})

plexRoute.post('/watchlist', async (c) => {
  const conn = await getUserPlexConnection(c.get('user').id)
  if (!conn) return c.json({ ok: false, error: 'Plex not configured' }, 400)
  const body = (await c.req.json().catch(() => ({}))) as { plexGuid?: string; ratingKey?: string }
  const ratingKey = (body.ratingKey ?? body.plexGuid ?? '').trim()
  if (!ratingKey) return c.json({ ok: false, error: 'ratingKey is required' }, 400)
  const ok = await addToPlexWatchlist(conn, ratingKey)
  return c.json({ ok })
})

// ── in-app playback ──────────────────────────────────────────────────────────────

plexRoute.get('/meta/:ratingKey', async (c) => {
  const conn = await getUserPlexConnection(c.get('user').id)
  if (!conn) return c.json({ error: 'Plex not configured' }, 400)
  const pb = await getPlayback(conn, c.req.param('ratingKey'))
  if (!pb) return c.json({ error: 'not found' }, 404)
  // Don't expose the internal part path to the client; it streams via /stream/:ratingKey.
  const { partKey: _omit, ...safe } = pb
  void _omit
  return c.json(safe)
})

plexRoute.get('/stream/:ratingKey', async (c) => {
  const conn = await getUserPlexConnection(c.get('user').id)
  if (!conn) return c.text('Plex not configured', 400)
  const pb = await getPlayback(conn, c.req.param('ratingKey'))
  if (!pb?.partKey) return c.text('No playable part', 404)
  const upstream = await streamPart(conn, pb.partKey, c.req.header('range'))
  if (!upstream || (!upstream.ok && upstream.status !== 206)) return c.text('Stream unavailable', 502)
  const h = new Headers()
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(k)
    if (v) h.set(k, v)
  }
  h.set('Cache-Control', 'private, max-age=0')
  return new Response(upstream.body, { status: upstream.status, headers: h })
})

// ── admin: link via plex.tv PIN, discover servers, save config ────────────────────

// ── plex.tv PIN sign-in (any authed user can link their own account) ──────────────

plexRoute.post('/auth/pin', async (c) => {
  const clientId = crypto.randomUUID()
  const pin = await createPlexPin(clientId)
  if (!pin) return c.json({ error: 'Could not start Plex sign-in' }, 502)
  return c.json(pin)
})

plexRoute.get('/auth/pin/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const clientId = c.req.query('clientId')
  if (!Number.isInteger(id) || !clientId) return c.json({ error: 'id and clientId are required' }, 400)
  const authToken = await checkPlexPin(id, clientId)
  return c.json({ authToken })
})

// ── current user: link / unlink their own Plex account ────────────────────────────

plexRoute.get('/me', async (c) => {
  const user = c.get('user')
  const linked = await isUserPlexLinked(user.id)
  const conn = linked ? await getUserPlexConnection(user.id) : null
  const status = conn ? await plexStatus(conn) : { ok: false, serverName: null }
  return c.json({ linked, ...status })
})

plexRoute.post('/me/link', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { token?: string }
  const token = body.token?.trim()
  if (!token) return c.json({ error: 'token is required' }, 400)
  await setUserPlexToken(user.id, token)
  const conn = await getUserPlexConnection(user.id)
  const status = conn ? await plexStatus(conn) : { ok: false, serverName: null }
  return c.json({ linked: true, ...status })
})

plexRoute.delete('/me', async (c) => {
  await setUserPlexToken(c.get('user').id, null)
  return c.json({ linked: false })
})

// ── admin: shared server config + discovery ───────────────────────────────────────

plexRoute.post('/auth/discover', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string; clientId?: string }
  if (!body.token || !body.clientId) return c.json({ error: 'token and clientId are required' }, 400)
  return c.json({ servers: await discoverPlexServers(body.token, body.clientId) })
})

plexRoute.get('/config', requireAdmin, async (c) => {
  return c.json(await getPlexConfigSummary())
})

plexRoute.post('/config', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { baseUrl?: string; token?: string }
  await savePlexConfig(body)
  // Verify the shared connection (admin token) if both pieces are now present.
  const conn = await getPlexConnection()
  const status = conn ? await plexStatus(conn) : { ok: false, serverName: null }
  return c.json({ saved: true, ...status })
})

// ── library sync policies (all / most-recent-N / remove-watched) ──────────────────

interface PolicyPatch { syncMode?: unknown; syncRecentCount?: unknown; removeWatched?: unknown }

/** Validate + apply a policy patch to one section row; returns an error string or null.
 *  Side effects: shrinking/entering 'recent' enforces immediately; widening back to 'all'
 *  re-backfills via a provision job (its backfill path re-adds every ready save). */
async function applyPolicyPatch(section: { id: string; userId: string; contentType: string; syncMode: string }, body: PolicyPatch): Promise<string | null> {
  const { db } = await import('@/db')
  const { plexLibrarySections } = await import('@/db/schema')
  const { eq } = await import('drizzle-orm')

  const patch: Record<string, unknown> = {}
  if (body.syncMode !== undefined) {
    if (body.syncMode !== 'all' && body.syncMode !== 'recent') return 'syncMode must be "all" or "recent"'
    patch.syncMode = body.syncMode
  }
  if (body.syncRecentCount !== undefined) {
    if (body.syncRecentCount !== null && (typeof body.syncRecentCount !== 'number' || !Number.isInteger(body.syncRecentCount) || body.syncRecentCount < 1 || body.syncRecentCount > 500)) {
      return 'syncRecentCount must be an integer 1-500 (or null for the default)'
    }
    patch.syncRecentCount = body.syncRecentCount
  }
  if (body.removeWatched !== undefined) {
    if (typeof body.removeWatched !== 'boolean') return 'removeWatched must be a boolean'
    if (body.removeWatched && section.contentType === 'mine') return 'removeWatched does not apply to My Videos — your own creations are never auto-deleted'
    patch.removeWatched = body.removeWatched
  }
  if (!Object.keys(patch).length) return 'nothing to update'

  await db.update(plexLibrarySections).set({ ...patch, updatedAt: new Date() }).where(eq(plexLibrarySections.id, section.id))

  const newMode = (patch.syncMode as string | undefined) ?? section.syncMode
  if (newMode === 'recent') {
    const { enforceLibraryPolicy } = await import('@/lib/plex/export/policy')
    void enforceLibraryPolicy(section.userId, section.contentType).catch(() => {})
  } else if (section.syncMode === 'recent' && newMode === 'all') {
    const { enqueuePlexProvision } = await import('@/lib/downloadJobs')
    void enqueuePlexProvision(section.userId, section.contentType).catch(() => {})
  }
  return null
}

/** The current user's own exported libraries + policies (drives the Videos settings UI).
 *  Also reports per-source storage readiness (a content_type_storage assignment whose
 *  location has a Plex path mapping — the same condition provisioning enforces), so the
 *  settings page can render unprovisioned sources disabled with the right "ask an admin"
 *  note instead of hiding them. */
plexRoute.get('/me/library-sections', async (c) => {
  const user = c.get('user')
  const { db } = await import('@/db')
  const { plexLibrarySections, plexPathMappings } = await import('@/db/schema')
  const { eq } = await import('drizzle-orm')
  const { PLEX_EXPORT_CONTENT_TYPES } = await import('@/lib/plex/export/contentTypes')
  const { getContentTypeStorageLocationId } = await import('@/lib/storage/contentRoots')
  const rows = await db.select().from(plexLibrarySections).where(eq(plexLibrarySections.userId, user.id))
  const storageReady: Record<string, boolean> = {}
  for (const ct of PLEX_EXPORT_CONTENT_TYPES) {
    const locId = await getContentTypeStorageLocationId(ct)
    if (!locId) { storageReady[ct] = false; continue }
    const [mapping] = await db.select({ id: plexPathMappings.id }).from(plexPathMappings)
      .where(eq(plexPathMappings.storageLocationId, locId)).limit(1)
    storageReady[ct] = !!mapping
  }
  return c.json({ sections: rows, storageReady })
})

plexRoute.patch('/me/library-sections/:contentType', async (c) => {
  const user = c.get('user')
  const contentType = c.req.param('contentType')
  const { db } = await import('@/db')
  const { plexLibrarySections } = await import('@/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const [section] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, user.id), eq(plexLibrarySections.contentType, contentType)))
    .limit(1)
  if (!section) return c.json({ error: 'no library provisioned for this source' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as PolicyPatch
  const err = await applyPolicyPatch(section, body)
  if (err) return c.json({ error: err }, 400)
  return c.json({ ok: true })
})

plexRoute.patch('/admin/library-sections/:id', requireAdmin, async (c) => {
  const { db } = await import('@/db')
  const { plexLibrarySections } = await import('@/db/schema')
  const { eq } = await import('drizzle-orm')
  const [section] = await db.select().from(plexLibrarySections)
    .where(eq(plexLibrarySections.id, c.req.param('id')))
    .limit(1)
  if (!section) return c.json({ error: 'section not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as PolicyPatch
  const err = await applyPolicyPatch(section, body)
  if (err) return c.json({ error: err }, 400)
  return c.json({ ok: true })
})

// ── admin: per-user library provisioning (Plex export feature) ────────────────────

plexRoute.get('/admin/library-sections', requireAdmin, async (c) => {
  const { db } = await import('@/db')
  const { plexLibrarySections } = await import('@/db/schema')
  const rows = await db.select().from(plexLibrarySections)
  return c.json({ sections: rows })
})

// Every Plex account the admin token can see (owner + friends + Plex Home users) — the
// options for mapping app users to Plex accounts without each person signing in.
plexRoute.get('/admin/accounts', requireAdmin, async (c) => {
  const conn = await getPlexConnection()
  if (!conn) return c.json({ accounts: [] })
  const { listPlexServerAccounts } = await import('@/lib/plex/auth')
  return c.json({ accounts: await listPlexServerAccounts(conn.token) })
})

// Map (or clear) an app user → Plex account. Mapping alone is enough to provision and
// share their private libraries; personal watchlist/scrobble sync still needs their own
// sign-in (Plex never exposes another account's token).
plexRoute.put('/admin/user-mapping', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { userId?: string; plexAccountId?: string | null; plexUsername?: string | null }
  if (!body.userId) return c.json({ error: 'userId is required' }, 400)
  const { setUserPlexMapping } = await import('@/lib/plex/account')
  await setUserPlexMapping(body.userId, body.plexAccountId
    ? { accountId: body.plexAccountId, username: body.plexUsername ?? null }
    : null)
  return c.json({ ok: true })
})

plexRoute.post('/admin/provision', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { userId?: string; contentType?: string }
  if (!body.userId || !body.contentType) return c.json({ ok: false, error: 'userId and contentType are required' }, 400)
  const { isPlexExportContentType } = await import('@/lib/plex/export/contentTypes')
  if (!isPlexExportContentType(body.contentType)) return c.json({ ok: false, error: `Unknown content type "${body.contentType}"` }, 400)
  const { enqueuePlexProvision } = await import('@/lib/downloadJobs')
  await enqueuePlexProvision(body.userId, body.contentType)
  return c.json({ ok: true })
})

export { plexRoute }
