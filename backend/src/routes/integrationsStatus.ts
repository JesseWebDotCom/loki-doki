// One admin endpoint aggregating every external-service integration's state, so the
// Integrations hub can render a status grid without nine per-card fetches. Two tiers:
// the default response is DB-only (configured / not configured, instant); `?probe=1`
// adds live reachability by reusing each integration's existing test helper, bounded
// per-probe and cached for 60s so a page of admins doesn't hammer LAN services.

import { Hono } from 'hono'
import type { AppEnv } from '@/types'
import { requireAdmin } from '@/middleware/auth'
import { getIntegrationsConfig, arrSystemStatus, overseerrTest } from '@/lib/media/integrations'
import { sabTest } from '@/lib/media/sabnzbd'
import { getPlexConnection, plexGet } from '@/lib/plex'
import { getGlobalConnection, getStore } from '@/lib/homeAssistant'
import { getFrigateConfig } from '@/lib/frigate/config'
import { getMonitoringConfig } from '@/lib/monitoring/config'
import { fetchMonitorStates } from '@/lib/monitoring/kuma'
import { listIndexers, testIndexer } from '@/lib/books/indexer'
import { listAccounts as listICloudAccounts, probeAccount as probeICloudAccount } from '@/lib/icloud/accounts'

export type IntegrationState = 'connected' | 'configured' | 'not_configured' | 'error'

export interface IntegrationStatusRow {
  id: string
  state: IntegrationState
  url: string | null
  detail: string | null
  error: string | null
}

const PROBE_TIMEOUT_MS = 4000
const PROBE_CACHE_MS = 60_000

/** Race a probe against a timeout; a slow or throwing probe resolves to the fallback. */
function within<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS)),
  ])
}

function row(id: string, partial: Omit<Partial<IntegrationStatusRow>, 'id'> & { state: IntegrationState }): IntegrationStatusRow {
  return { id, url: null, detail: null, error: null, ...partial }
}

async function computeRows(probe: boolean): Promise<IntegrationStatusRow[]> {
  const [media, plexConn, haConn, frigateCfg, kumaCfg, indexers] = await Promise.all([
    getIntegrationsConfig(),
    getPlexConnection(),
    getGlobalConnection(),
    getFrigateConfig(),
    getMonitoringConfig(),
    listIndexers(),
  ])

  const rows: IntegrationStatusRow[] = []

  // Sonarr / Radarr / Overseerr / SABnzbd share one config blob.
  const arrServices = [
    { id: 'sonarr', url: media.sonarr_url, key: media.sonarr_key, test: () => arrSystemStatus('sonarr') },
    { id: 'radarr', url: media.radarr_url, key: media.radarr_key, test: () => arrSystemStatus('radarr') },
    { id: 'overseerr', url: media.overseerr_url, key: media.overseerr_key, test: () => overseerrTest() },
    { id: 'sabnzbd', url: media.sabnzbd_url, key: media.sabnzbd_key, test: () => sabTest() },
  ]
  await Promise.all(arrServices.map(async (svc) => {
    if (!svc.url || !svc.key) return rows.push(row(svc.id, { state: 'not_configured' }))
    if (!probe) return rows.push(row(svc.id, { state: 'configured', url: svc.url }))
    const res = await within(svc.test(), { ok: false })
    rows.push(row(svc.id, {
      state: res.ok ? 'connected' : 'error',
      url: svc.url,
      detail: 'version' in res && res.version ? `v${res.version}` : null,
      error: res.ok ? null : 'Unreachable',
    }))
  }))

  // Plex: connection row exists only when base_url + token are stored.
  if (!plexConn) {
    rows.push(row('plex', { state: 'not_configured' }))
  } else if (!probe) {
    rows.push(row('plex', { state: 'configured', url: plexConn.baseUrl }))
  } else {
    const identity = await within(
      plexGet<{ MediaContainer?: { version?: string } }>(plexConn, '/identity'),
      null,
    )
    rows.push(row('plex', {
      state: identity ? 'connected' : 'error',
      url: plexConn.baseUrl,
      detail: identity?.MediaContainer?.version ? `v${identity.MediaContainer.version}` : null,
      error: identity ? null : 'Unreachable',
    }))
  }

  // Home Assistant keeps a live socket, so connected/error is known without probing.
  if (!haConn) {
    rows.push(row('home-assistant', { state: 'not_configured' }))
  } else {
    const store = getStore(haConn)
    const connected = store?.connected ?? false
    rows.push(row('home-assistant', {
      state: connected ? 'connected' : store?.lastError ? 'error' : 'configured',
      url: haConn.baseUrl,
      detail: connected ? `${store?.entities.size ?? 0} entities` : null,
      error: connected ? null : store?.lastError ?? null,
    }))
  }

  // Frigate NVR.
  if (!frigateCfg.baseUrl) {
    rows.push(row('frigate', { state: 'not_configured' }))
  } else if (!probe) {
    rows.push(row('frigate', { state: 'configured', url: frigateCfg.baseUrl }))
  } else {
    const version = await within(
      fetch(`${frigateCfg.baseUrl}/api/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        .then(async (r) => (r.ok ? (await r.text()).trim().slice(0, 40) : null)),
      null,
    )
    rows.push(row('frigate', {
      state: version ? 'connected' : 'error',
      url: frigateCfg.baseUrl,
      detail: version ? `v${version}` : null,
      error: version ? null : 'Unreachable',
    }))
  }

  // Uptime Kuma.
  if (!kumaCfg.baseUrl || !kumaCfg.apiKey) {
    rows.push(row('uptime-kuma', { state: 'not_configured' }))
  } else if (!probe) {
    rows.push(row('uptime-kuma', { state: 'configured', url: kumaCfg.baseUrl }))
  } else {
    const states = await within(
      fetchMonitorStates(kumaCfg.baseUrl, kumaCfg.apiKey).then((s) => s as Map<string, number> | null),
      null,
    )
    rows.push(row('uptime-kuma', {
      state: states ? 'connected' : 'error',
      url: kumaCfg.baseUrl,
      detail: states ? `${states.size} monitors` : null,
      error: states ? null : 'Unreachable',
    }))
  }

  // Self-hosted OPDS book indexers (any number; the row summarizes the set).
  const enabledIndexers = indexers.filter((i) => i.enabled)
  if (!enabledIndexers.length) {
    rows.push(row('opds', { state: 'not_configured', detail: indexers.length ? `${indexers.length} disabled` : null }))
  } else if (!probe) {
    rows.push(row('opds', {
      state: 'configured',
      url: enabledIndexers[0]!.baseUrl,
      detail: `${enabledIndexers.length} indexer${enabledIndexers.length === 1 ? '' : 's'}`,
    }))
  } else {
    const results = await Promise.all(enabledIndexers.map((i) => within(testIndexer(i.id), { ok: false })))
    const okCount = results.filter((r) => r.ok).length
    rows.push(row('opds', {
      state: okCount === enabledIndexers.length ? 'connected' : okCount > 0 ? 'connected' : 'error',
      url: enabledIndexers[0]!.baseUrl,
      detail: `${okCount}/${enabledIndexers.length} indexer${enabledIndexers.length === 1 ? '' : 's'} reachable`,
      error: okCount === 0 ? 'No indexer reachable' : null,
    }))
  }

  // Apple iCloud: one row summarizing every member's connection. Any auth_error wins
  // the row state — that's the "ASP was revoked, reconnect" signal admins must see.
  {
    let accounts = await listICloudAccounts()
    if (!accounts.length) {
      rows.push(row('apple-icloud', { state: 'not_configured' }))
    } else {
      if (probe) {
        const probed = await Promise.all(accounts.map((a) => within(probeICloudAccount(a.id), a)))
        accounts = probed.map((a, i) => a ?? accounts[i]!)
      }
      const authErrored = accounts.filter((a) => a.caldavStatus === 'auth_error' || a.imapStatus === 'auth_error')
      const errored = accounts.filter((a) => a.caldavStatus === 'error' || a.imapStatus === 'error')
      const allOk = accounts.every((a) => a.caldavStatus === 'ok' && a.imapStatus === 'ok')
      const memberCount = `${accounts.length} member${accounts.length === 1 ? '' : 's'}`
      if (authErrored.length) {
        rows.push(row('apple-icloud', {
          state: 'error',
          detail: memberCount,
          error: `Reconnect needed for ${authErrored.map((a) => a.userNickname).join(', ')}`,
        }))
      } else if (probe || accounts.some((a) => a.lastProbeAt)) {
        rows.push(row('apple-icloud', {
          state: allOk ? 'connected' : errored.length ? 'error' : 'configured',
          detail: memberCount,
          error: errored.length ? (errored[0]!.lastError ?? 'Unreachable') : null,
        }))
      } else {
        rows.push(row('apple-icloud', { state: 'configured', detail: memberCount }))
      }
    }
  }

  return rows
}

let probeCache: { at: number; rows: IntegrationStatusRow[] } | null = null

const integrationsStatus = new Hono<AppEnv>()

integrationsStatus.get('/status', requireAdmin, async (c) => {
  const probe = c.req.query('probe') === '1'
  if (!probe) return c.json({ rows: await computeRows(false), probed: false })
  if (probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) {
    return c.json({ rows: probeCache.rows, probed: true, cached: true })
  }
  const rows = await computeRows(true)
  probeCache = { at: Date.now(), rows }
  return c.json({ rows, probed: true })
})

export { integrationsStatus }
