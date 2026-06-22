import { Hono } from 'hono'
import os from 'node:os'
import { requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import * as genQueue from '@/lib/genQueue'
import type { AppEnv } from '@/types'

const adminQueue = new Hono<AppEnv>()

// ── GET /api/admin/queue/config ───────────────────────────────────────────────
// Returns the current mode, all three limit sets, dynamic params, and a live snapshot.

adminQueue.get('/config', requireAdmin, async (c) => {
  const [mode, manual, suggested, dynamic, snap] = await Promise.all([
    getAppSetting('queue.mode'),
    getAppSetting('queue.limits.manual'),
    getAppSetting('queue.limits.suggested'),
    getAppSetting('queue.dynamic'),
    genQueue.snapshot(),
  ])

  return c.json({
    mode: (mode as string | null) ?? 'suggested',
    limits: {
      manual:    manual    ?? { chat: 2, image: 1, vision: 1 },
      suggested: suggested ?? { chat: 2, image: 1, vision: 1 },
      dynamic:   snap.limits,   // current runtime limits when mode=dynamic
    },
    dynamicConfig: dynamic ?? {
      loadHighWatermark: 0.75,
      loadLowWatermark:  0.40,
      min: { chat: 1, image: 1, vision: 1 },
      max: { chat: 4, image: 2, vision: 2 },
    },
    snapshot: snap,
  })
})

// ── PUT /api/admin/queue/config ───────────────────────────────────────────────
// Update mode, manual limits, and/or dynamic params.

adminQueue.put('/config', requireAdmin, async (c) => {
  const body = await c.req.json() as {
    mode?: string
    manualLimits?: { chat?: number; image?: number; vision?: number }
    dynamicConfig?: {
      loadHighWatermark?: number
      loadLowWatermark?: number
      min?: { chat?: number; image?: number; vision?: number }
      max?: { chat?: number; image?: number; vision?: number }
    }
  }

  const writes: Promise<void>[] = []

  if (body.mode !== undefined) {
    const valid = ['manual', 'suggested', 'dynamic']
    if (!valid.includes(body.mode)) return c.json({ error: 'Invalid mode' }, 400)
    writes.push(setAppSetting('queue.mode', body.mode))
  }

  if (body.manualLimits !== undefined) {
    // Merge with existing manual limits to allow partial updates
    const existing = (await getAppSetting('queue.limits.manual') as Record<string, number> | null) ?? { chat: 2, image: 1, vision: 1 }
    const merged = {
      chat:   Math.max(1, body.manualLimits.chat   ?? existing.chat   ?? 2),
      image:  Math.max(1, body.manualLimits.image  ?? existing.image  ?? 1),
      vision: Math.max(1, body.manualLimits.vision ?? existing.vision ?? 1),
    }
    writes.push(setAppSetting('queue.limits.manual', merged))
  }

  if (body.dynamicConfig !== undefined) {
    const existing = (await getAppSetting('queue.dynamic') as Record<string, unknown> | null) ?? {}
    const merged = { ...existing, ...body.dynamicConfig }
    writes.push(setAppSetting('queue.dynamic', merged))
  }

  await Promise.all(writes)
  return c.json({ ok: true })
})

// ── GET /api/admin/queue/status ───────────────────────────────────────────────
// Lightweight poll target for the admin tab. Returns snapshot + system load.

adminQueue.get('/status', requireAdmin, async (c) => {
  const snap = await genQueue.snapshot()
  const cpuCount = Math.max(1, os.cpus().length)
  return c.json({
    ...snap,
    system: {
      loadAvg1m:  os.loadavg()[0],
      loadAvg5m:  os.loadavg()[1],
      loadNorm:   os.loadavg()[0] / cpuCount,
      totalRamGb: Math.round(os.totalmem() / 1_073_741_824),
      freeRamGb:  Math.round(os.freemem()  / 1_073_741_824),
      cpuCount,
    },
  })
})

export { adminQueue }
