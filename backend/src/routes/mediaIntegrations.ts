// Admin config + user-facing endpoints for the optional LAN media integrations
// (Sonarr/Radarr calendars, Overseerr requests). Mounted at /api/media-integrations.

import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { mediaRequests, users } from '@/db/schema'
import {
  getIntegrationsConfig, setIntegrationsConfig, getLibraryCalendar,
  overseerrTest, arrSystemStatus, radarrQueue, sonarrQueue,
  radarrProfiles, radarrRootFolders, sonarrProfiles, sonarrRootFolders,
  INTEGRATION_KEYS, INTEGRATION_SECRET_KEYS, getRequestPipeline, type IntegrationKey,
} from '@/lib/media/integrations'
import {
  canUserRequest, fileRequest, listMyRequests, listRequestGrants, requestStatusFor, setRequestGrant,
} from '@/lib/media/requests'
import {
  sabDeleteItem, sabHistory, sabPauseItem, sabPauseQueue, sabQueue, sabResumeItem, sabResumeQueue, sabTest,
} from '@/lib/media/sabnzbd'
import type { AppEnv } from '@/types'

const mediaIntegrationsRoute = new Hono<AppEnv>()

// Admin: read config (keys are masked — presence only) and write it.
mediaIntegrationsRoute.get('/config', requireAdmin, async (c) => {
  const cfg = await getIntegrationsConfig()
  return c.json({
    sonarr_url: cfg.sonarr_url,
    radarr_url: cfg.radarr_url,
    overseerr_url: cfg.overseerr_url,
    sabnzbd_url: cfg.sabnzbd_url,
    sonarr_key_set: !!cfg.sonarr_key,
    radarr_key_set: !!cfg.radarr_key,
    overseerr_key_set: !!cfg.overseerr_key,
    sabnzbd_key_set: !!cfg.sabnzbd_key,
    request_pipeline: await getRequestPipeline(),
    radarr_quality_profile_id: cfg.radarr_quality_profile_id,
    radarr_root_folder: cfg.radarr_root_folder,
    sonarr_quality_profile_id: cfg.sonarr_quality_profile_id,
    sonarr_root_folder: cfg.sonarr_root_folder,
  })
})

mediaIntegrationsRoute.put('/config', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<Record<IntegrationKey, string>>
  const patch: Partial<Record<IntegrationKey, string>> = {}
  for (const k of INTEGRATION_KEYS) {
    if (typeof body[k] !== 'string') continue
    // A blank secret field means "keep the stored key", never clobber.
    if (INTEGRATION_SECRET_KEYS.includes(k) && !body[k]?.trim()) continue
    patch[k] = body[k]
  }
  await setIntegrationsConfig(patch)
  return c.json({ ok: true })
})

// Admin: probe every configured service; also returns arr pickers (profiles + root folders).
mediaIntegrationsRoute.get('/test', requireAdmin, async (c) => {
  const [sonarr, radarr, overseerr, sabnzbd] = await Promise.all([
    arrSystemStatus('sonarr'), arrSystemStatus('radarr'), overseerrTest(), sabTest(),
  ])
  const [radarrQp, radarrRf, sonarrQp, sonarrRf] = await Promise.all([
    radarr.ok ? radarrProfiles() : [], radarr.ok ? radarrRootFolders() : [],
    sonarr.ok ? sonarrProfiles() : [], sonarr.ok ? sonarrRootFolders() : [],
  ])
  return c.json({
    sonarr: { ...sonarr, qualityProfiles: sonarrQp, rootFolders: sonarrRf },
    radarr: { ...radarr, qualityProfiles: radarrQp, rootFolders: radarrRf },
    overseerr,
    sabnzbd,
  })
})

// "Coming to your library": merged Sonarr episodes + Radarr releases, next 14 days.
mediaIntegrationsRoute.get('/calendar', requireAuth, async (c) => {
  const entries = await getLibraryCalendar(14)
  return c.json({ entries })
})

// Pipeline-aware status for a title as seen by the calling user (drives the Request button).
mediaIntegrationsRoute.get('/request-status', requireAuth, async (c) => {
  const user = c.get('user')
  const title = c.req.query('title')?.trim()
  const mediaType = c.req.query('type') === 'show' ? 'show' : 'movie'
  const year = Number(c.req.query('year')) || null
  const refId = c.req.query('refId')?.trim() || title
  if (!title || !refId) return c.json({ error: 'title is required' }, 400)
  return c.json(await requestStatusFor(user.id, user.role === 'admin', {
    type: mediaType, title, year,
    imdb: c.req.query('imdb')?.trim() || null,
    tvdb: Number(c.req.query('tvdb')) || null,
    refId,
  }))
})

// File a request through the active pipeline (Overseerr on the user's behalf, or direct arr).
mediaIntegrationsRoute.post('/request', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: string; title?: string; year?: number; imdb?: string; tvdb?: number
    tmdbId?: number; posterUrl?: string; refId?: string
  }
  const title = body.title?.trim()
  const type = body.type === 'show' ? 'show' as const : 'movie' as const
  const refId = body.refId?.trim() || title
  if (!title || !refId) return c.json({ error: 'title is required' }, 400)

  const permission = await canUserRequest(user.id, user.role === 'admin')
  if (!permission.ok) {
    const message = permission.reason === 'link_plex'
      ? 'Link your Plex account to request titles'
      : permission.reason === 'grant'
        ? 'You do not have permission to request downloads'
        : 'Requests are not configured'
    return c.json({ error: message, reason: permission.reason }, permission.reason === 'unconfigured' ? 503 : 403)
  }

  try {
    const row = await fileRequest(user.id, {
      type, title, year: Number(body.year) || null,
      imdb: body.imdb?.trim() || null, tvdb: Number(body.tvdb) || null,
      tmdbId: Number(body.tmdbId) || null, posterUrl: body.posterUrl?.trim() || null,
      refId, origin: 'app',
    })
    return c.json({ ok: true, request: row })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Request failed' }, 502)
  }
})

// The calling user's requests (My Requests section).
mediaIntegrationsRoute.get('/requests/mine', requireAuth, async (c) => {
  const user = c.get('user')
  return c.json({ requests: await listMyRequests(user.id) })
})

// Remove a request row (owner or admin). Does not cancel the download externally.
mediaIntegrationsRoute.delete('/requests/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(mediaRequests).where(eq(mediaRequests.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.userId !== user.id && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await db.delete(mediaRequests).where(eq(mediaRequests.id, id))
  return c.json({ ok: true })
})

// Admin: per-user grants for the direct Radarr/Sonarr pipeline.
mediaIntegrationsRoute.get('/grants', requireAdmin, async (c) => {
  const [grants, allUsers] = await Promise.all([
    listRequestGrants(),
    db.select({ id: users.id, nickname: users.nickname, role: users.role }).from(users),
  ])
  return c.json({
    users: allUsers.map((u) => ({
      id: u.id, name: u.nickname, role: u.role,
      allowed: u.role === 'admin' ? true : (grants[u.id] ?? false),
    })),
  })
})

mediaIntegrationsRoute.put('/grants/:userId', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { allowed?: boolean }
  await setRequestGrant(c.req.param('userId'), body.allowed === true)
  return c.json({ ok: true })
})

// ── Admin download-queue management (SABnzbd + arr queues) ───────────────────────────

mediaIntegrationsRoute.get('/downloads', requireAdmin, async (c) => {
  const [queue, history, radarr, sonarr] = await Promise.all([
    sabQueue(), sabHistory(30), radarrQueue(), sonarrQueue(),
  ])
  return c.json({
    sab: queue ? { ...queue, history: history ?? [] } : null,
    arr: [...radarr, ...sonarr],
  })
})

mediaIntegrationsRoute.post('/downloads/queue/pause', requireAdmin, async (c) => {
  return (await sabPauseQueue()) ? c.json({ ok: true }) : c.json({ error: 'SABnzbd did not respond' }, 502)
})

mediaIntegrationsRoute.post('/downloads/queue/resume', requireAdmin, async (c) => {
  return (await sabResumeQueue()) ? c.json({ ok: true }) : c.json({ error: 'SABnzbd did not respond' }, 502)
})

mediaIntegrationsRoute.post('/downloads/item/:nzoId/pause', requireAdmin, async (c) => {
  return (await sabPauseItem(c.req.param('nzoId'))) ? c.json({ ok: true }) : c.json({ error: 'SABnzbd did not respond' }, 502)
})

mediaIntegrationsRoute.post('/downloads/item/:nzoId/resume', requireAdmin, async (c) => {
  return (await sabResumeItem(c.req.param('nzoId'))) ? c.json({ ok: true }) : c.json({ error: 'SABnzbd did not respond' }, 502)
})

mediaIntegrationsRoute.delete('/downloads/item/:nzoId', requireAdmin, async (c) => {
  return (await sabDeleteItem(c.req.param('nzoId'))) ? c.json({ ok: true }) : c.json({ error: 'SABnzbd did not respond' }, 502)
})

// Widget feed. Admins see the household queue; everyone sees their own in-flight requests.
mediaIntegrationsRoute.get('/downloads/summary', requireAuth, async (c) => {
  const user = c.get('user')
  const isAdmin = user.role === 'admin'
  const mine = (await listMyRequests(user.id)).filter((r) => r.status === 'requested' || r.status === 'downloading')

  if (!isAdmin) {
    const cfg = await getIntegrationsConfig()
    const configured = !!((cfg.radarr_url && cfg.radarr_key) || (cfg.sonarr_url && cfg.sonarr_key) || (cfg.overseerr_url && cfg.overseerr_key))
    return c.json({ configured, admin: false, mine, queue: null })
  }

  const cfg = await getIntegrationsConfig()
  const configured = !!(cfg.sabnzbd_url && cfg.sabnzbd_key) || !!((cfg.radarr_url && cfg.radarr_key) || (cfg.sonarr_url && cfg.sonarr_key))
  const queue = await sabQueue()
  return c.json({
    configured, admin: true, mine,
    queue: queue ? {
      paused: queue.paused, speed: queue.speed, sizeLeft: queue.sizeLeft,
      count: queue.slots.length, top: queue.slots.slice(0, 3),
    } : null,
  })
})

export { mediaIntegrationsRoute }
