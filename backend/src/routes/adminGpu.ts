import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import {
  getGpuHealth,
  getGpuAlertConfig,
  setGpuAlertConfig,
  resetGpuBaseline,
  type GpuAlertConfigPatch,
} from '@/lib/gpuMonitor'
import type { AppEnv } from '@/types'

const adminGpu = new Hono<AppEnv>()
adminGpu.use('*', requireAdmin)

// Live per-GPU utilization + health verdict. Polled by the admin System tab and the global
// GPU-health toaster.
adminGpu.get('/status', async (c) => c.json(await getGpuHealth()))

adminGpu.get('/config', async (c) => c.json(await getGpuAlertConfig()))

adminGpu.put('/config', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as GpuAlertConfigPatch
  return c.json(await setGpuAlertConfig(body))
})

// Re-baseline the expected-GPU set to what's present now (clears a stale "missing" alert after a
// card is intentionally removed).
adminGpu.post('/reset-baseline', async (c) => {
  await resetGpuBaseline()
  return c.json({ ok: true })
})

export { adminGpu }
