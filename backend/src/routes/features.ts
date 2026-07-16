// Admin API for the one-switch Features hub: list every user-facing feature with its
// derived state and aggregate bytes required, and enable/disable/repair through the
// orchestrator. Per-user visibility gating stays on /api/app-features (unchanged).

import { Hono } from 'hono'
import type { Context } from 'hono'
import { statfs } from 'node:fs/promises'
import { requireAdmin } from '@/middleware/auth'
import { dataDir } from '@/lib/download'
import { listFeatureStatuses } from '@/lib/features/status'
import { enableFeature, disableFeature, repairFeature, FeatureError } from '@/lib/features/orchestrator'
import type { AppEnv } from '@/types'

async function disk(): Promise<{ freeBytes: number; totalBytes: number }> {
  try {
    const s = await statfs(dataDir)
    return { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail }
  } catch {
    return { freeBytes: 0, totalBytes: 0 }
  }
}

const features = new Hono<AppEnv>()

features.get('/', requireAdmin, async (c) => {
  const [featureList, diskInfo] = await Promise.all([listFeatureStatuses(), disk()])
  return c.json({ features: featureList, disk: diskInfo })
})

function errorResponse(c: Context<AppEnv>, err: unknown) {
  if (err instanceof FeatureError) {
    return c.json({ error: err.message, code: err.code }, err.code === 'unknown_feature' ? 404 : 409)
  }
  throw err
}

features.post('/:id/enable', requireAdmin, async (c) => {
  try {
    return c.json(await enableFeature(c.req.param('id'), c.get('user')?.id))
  } catch (err) { return errorResponse(c, err) }
})

features.post('/:id/disable', requireAdmin, async (c) => {
  try {
    return c.json(await disableFeature(c.req.param('id'), c.get('user')?.id))
  } catch (err) { return errorResponse(c, err) }
})

features.post('/:id/repair', requireAdmin, async (c) => {
  try {
    return c.json(await repairFeature(c.req.param('id'), c.get('user')?.id))
  } catch (err) { return errorResponse(c, err) }
})

export { features }
