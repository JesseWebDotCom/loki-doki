import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { catalogTree, getRegion } from '@/lib/maps/catalog'
import { aggregateStorage, getRegionState, listInstalledRegions, removeRegion } from '@/lib/maps/store'
import { buildRegion, reindexRegion, type BuildEvent } from '@/lib/maps/build'
import { installMapsToolchain, isMapsToolchainInstalled } from '@/lib/maps/toolchain'
import { isGloballyOffline, isDownloadBlocked } from '@/lib/connectivity'

const adminMaps = new Hono<AppEnv>()
adminMaps.use('*', requireAdmin)

// In-flight builds, keyed by regionId, so they can be cancelled.
const activeBuilds = new Map<string, AbortController>()

// ── Catalog (tree + install state) ──────────────────────────────────────────────
adminMaps.get('/catalog', (c) => {
  const installed = new Map(listInstalledRegions().map((s) => [s.regionId, s]))
  const annotate = (nodes: ReturnType<typeof catalogTree>): unknown[] =>
    nodes.map((n) => {
      const state = installed.get(n.regionId)
      return {
        region_id: n.regionId,
        label: n.label,
        parent_id: n.parentId,
        center: n.center,
        bbox: n.bbox,
        sizes_mb: n.sizesMb,
        downloadable: n.downloadable,
        installed: state?.installStatus === 'ready',
        install_status: state?.installStatus ?? null,
        phase: state?.phase ?? null,
        building: !!activeBuilds.has(n.regionId),
        last_error: state?.lastError ?? null,
        children: annotate(n.children),
      }
    })
  return c.json({
    regions: annotate(catalogTree()),
    toolchainInstalled: isMapsToolchainInstalled(),
  })
})

adminMaps.get('/storage', (c) => {
  const totals = aggregateStorage()
  return c.json({
    totals,
    total_bytes: Object.values(totals).reduce((a, b) => a + b, 0),
    regions: listInstalledRegions().map((s) => ({
      region_id: s.regionId,
      bytes_on_disk: s.bytesOnDisk,
      install_status: s.installStatus,
    })),
  })
})

// ── Install toolchain (JRE + planetiler + graphhopper + glyphs) ──────────────────
adminMaps.post('/install-toolchain', async (c) => {
  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active — downloads are unavailable.' }, 503)
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    stream.onAbort(() => ctrl.abort())
    try {
      await installMapsToolchain(
        (msg) => stream.writeSSE({ event: 'status', data: JSON.stringify({ msg }) }),
        ctrl.signal,
      )
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true }) })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        await stream.writeSSE({ event: 'cancelled', data: '{}' })
        return
      }
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ msg: String(err) }) })
    }
  })
})

// ── Download + build a region ───────────────────────────────────────────────────
adminMaps.get('/download/:regionId', async (c) => {
  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active — downloads are unavailable.' }, 503)
  const regionId = c.req.param('regionId')
  if (!getRegion(regionId)) return c.json({ error: 'unknown_region' }, 404)
  if (activeBuilds.has(regionId)) return c.json({ error: 'already_building' }, 409)
  if (!isMapsToolchainInstalled()) return c.json({ error: 'toolchain_not_installed' }, 409)

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    activeBuilds.set(regionId, ctrl)
    stream.onAbort(() => ctrl.abort())

    // Serialize SSE writes: build phases emit bursts of events, and overlapping
    // writeSSE calls on one stream drop frames. Chain them so each completes
    // before the next starts.
    let chain: Promise<void> = Promise.resolve()
    const emit = (e: BuildEvent) => {
      chain = chain.then(() => stream.writeSSE({ event: 'progress', data: JSON.stringify(e) }).catch(() => {}))
    }

    try {
      await buildRegion(regionId, emit, ctrl.signal)
      await chain
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ regionId }) })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        await stream.writeSSE({ event: 'cancelled', data: JSON.stringify({ regionId }) })
      } else {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ msg: String(err) }) })
      }
    } finally {
      activeBuilds.delete(regionId)
    }
  })
})

adminMaps.post('/cancel/:regionId', (c) => {
  const ctrl = activeBuilds.get(c.req.param('regionId'))
  if (ctrl) { ctrl.abort(); activeBuilds.delete(c.req.param('regionId')) }
  return c.json({ ok: true })
})

adminMaps.post('/reindex/:regionId', (c) => {
  const regionId = c.req.param('regionId')
  if (!getRegionState(regionId)) return c.json({ error: 'unknown_region' }, 404)
  if (activeBuilds.has(regionId)) return c.json({ error: 'already_building' }, 409)
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    activeBuilds.set(regionId, ctrl)
    stream.onAbort(() => ctrl.abort())
    let chain: Promise<void> = Promise.resolve()
    const emit = (e: BuildEvent) => {
      chain = chain.then(() => stream.writeSSE({ event: 'progress', data: JSON.stringify(e) }).catch(() => {}))
    }
    try {
      await reindexRegion(regionId, emit, ctrl.signal)
      await chain
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ regionId }) })
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ msg: String(err) }) })
    } finally {
      activeBuilds.delete(regionId)
    }
  })
})

adminMaps.delete('/:regionId', async (c) => {
  const regionId = c.req.param('regionId')
  const ctrl = activeBuilds.get(regionId)
  if (ctrl) { ctrl.abort(); activeBuilds.delete(regionId) }
  await removeRegion(regionId)
  return c.json({ ok: true })
})

export { adminMaps }
