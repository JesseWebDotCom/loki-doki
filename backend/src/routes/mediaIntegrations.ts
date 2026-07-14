// Admin config + user-facing endpoints for the optional LAN media integrations
// (Sonarr/Radarr calendars, Overseerr requests). Mounted at /api/media-integrations.

import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import {
  getIntegrationsConfig, setIntegrationsConfig, getLibraryCalendar,
  overseerrStatus, overseerrRequest, INTEGRATION_KEYS, type IntegrationKey,
} from '@/lib/media/integrations'
import type { AppEnv } from '@/types'

const mediaIntegrationsRoute = new Hono<AppEnv>()

// Admin: read config (keys are masked — presence only) and write it.
mediaIntegrationsRoute.get('/config', requireAdmin, async (c) => {
  const cfg = await getIntegrationsConfig()
  return c.json({
    sonarr_url: cfg.sonarr_url,
    radarr_url: cfg.radarr_url,
    overseerr_url: cfg.overseerr_url,
    sonarr_key_set: !!cfg.sonarr_key,
    radarr_key_set: !!cfg.radarr_key,
    overseerr_key_set: !!cfg.overseerr_key,
  })
})

mediaIntegrationsRoute.put('/config', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<Record<IntegrationKey, string>>
  const patch: Partial<Record<IntegrationKey, string>> = {}
  for (const k of INTEGRATION_KEYS) if (typeof body[k] === 'string') patch[k] = body[k]
  await setIntegrationsConfig(patch)
  return c.json({ ok: true })
})

// "Coming to your library": merged Sonarr episodes + Radarr releases, next 14 days.
mediaIntegrationsRoute.get('/calendar', requireAuth, async (c) => {
  const entries = await getLibraryCalendar(14)
  return c.json({ entries })
})

// Overseerr status for a title (drives the Request button on detail pages).
mediaIntegrationsRoute.get('/request-status', requireAuth, async (c) => {
  const title = c.req.query('title')?.trim()
  const mediaType = c.req.query('type') === 'show' ? 'show' : 'movie'
  const year = Number(c.req.query('year')) || null
  if (!title) return c.json({ error: 'title is required' }, 400)
  return c.json(await overseerrStatus(title, year, mediaType))
})

mediaIntegrationsRoute.post('/request', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tmdbId?: number; type?: string }
  const tmdbId = Number(body.tmdbId)
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return c.json({ error: 'tmdbId is required' }, 400)
  const ok = await overseerrRequest(tmdbId, body.type === 'show' ? 'show' : 'movie')
  return ok ? c.json({ ok: true }) : c.json({ error: 'Request failed' }, 502)
})

export { mediaIntegrationsRoute }
