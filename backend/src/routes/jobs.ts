import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import {
  enqueueBackground,
  getBackgroundActivity,
  getJobsStatus,
  retryJob,
  cancelJob,
  retryAllFailed,
  dismissAllFailed,
  type EnqueueInput,
} from '@/lib/downloadJobs'
import { isOpportunisticEnabled, setOpportunisticEnabled } from '@/lib/idleScheduler'
import type { AppEnv } from '@/types'

const jobs = new Hono<AppEnv>()

// Aggregate + per-job status for the global background-setup widget.
jobs.get('/status', requireAuth, async (c) => c.json(await getJobsStatus()))

// The opportunistic band: idle-gate verdict + queue state for the Admin card.
jobs.get('/background', requireAdmin, async (c) => c.json(await getBackgroundActivity()))
jobs.put('/background', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean }
  const enabled = typeof body.enabled === 'boolean' ? await setOpportunisticEnabled(body.enabled) : isOpportunisticEnabled()
  return c.json({ ok: true, enabled })
})

// First-run handoff: enqueue everything non-essential. Idempotent. Admin-only — the
// setup flow runs as the admin, and a non-admin shouldn't be able to trigger GB downloads.
jobs.post('/enqueue', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as EnqueueInput
  const created = await enqueueBackground(body)
  return c.json({ ok: true, created })
})

jobs.post('/:id/retry', requireAdmin, async (c) => { await retryJob(c.req.param('id')); return c.json({ ok: true }) })
jobs.post('/:id/cancel', requireAdmin, async (c) => { await cancelJob(c.req.param('id')); return c.json({ ok: true }) })
jobs.post('/retry-all-failed', requireAdmin, async (c) => { await retryAllFailed(); return c.json({ ok: true }) })
jobs.post('/dismiss-failed', requireAdmin, async (c) => { await dismissAllFailed(); return c.json({ ok: true }) })

export { jobs }
