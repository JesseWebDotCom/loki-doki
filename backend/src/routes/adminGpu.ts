import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import {
  getGpuHealth,
  getGpuAlertConfig,
  setGpuAlertConfig,
  resetGpuBaseline,
  type GpuAlertConfigPatch,
} from '@/lib/gpuMonitor'
import { getCachedEngineGuards, saveEngineGuards, type EngineGuards } from '@/lib/engineGuards'
import { sweepOrphanLlamaRunners } from '@/lib/ollamaHygiene'
import { restartOllamaServe } from '@/lib/download'
import { stopCodingEngine, CODING_ENGINE_BASE } from '@/lib/codingEngine'
import { ollamaUnloadModel } from '@/llm/ollama'
import { getLlmStatus } from '@/lib/llmStatus'
import { adminAuditLog } from '@/db/schema'
import { db } from '@/db'
import type { AppEnv } from '@/types'

const adminGpu = new Hono<AppEnv>()
adminGpu.use('*', requireAdmin)

type EngineAuditAction = 'engine_restart' | 'engine_unload' | 'engine_guards_update' | 'engine_sweep'
async function audit(userId: string, action: EngineAuditAction, detail?: unknown): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      id: crypto.randomUUID(), userId, action,
      detail: detail === undefined ? null : JSON.stringify(detail), createdAt: new Date(),
    })
  } catch { /* audit is best-effort */ }
}

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

// ── AI engine guards + control actions (Admin → System → AI engine) ──────────

adminGpu.get('/engine-guards', (c) => c.json(getCachedEngineGuards()))

// Save guards; env is baked at engine spawn, so changes need a restart to take effect.
adminGpu.put('/engine-guards', async (c) => {
  const patch = (await c.req.json().catch(() => ({}))) as Partial<EngineGuards>
  const saved = await saveEngineGuards(patch)
  await audit(c.get('user').id, 'engine_guards_update', saved)
  return c.json({ ...saved, needsRestart: true })
})

// Release one model's runner now (keep_alive: 0; in-flight generations finish first).
adminGpu.post('/unload', async (c) => {
  const { model, engine } = (await c.req.json().catch(() => ({}))) as { model?: string; engine?: 'main' | 'coding' }
  if (!model) return c.json({ error: 'model required' }, 400)
  await ollamaUnloadModel(model, engine === 'coding' ? CODING_ENGINE_BASE : undefined)
  await audit(c.get('user').id, 'engine_unload', { model, engine: engine ?? 'main' })
  return c.json({ ok: true })
})

// Release every loaded model on both local engines (they reload on demand).
adminGpu.post('/free-vram', async (c) => {
  const status = await getLlmStatus()
  await Promise.all(status.models.map((m) =>
    ollamaUnloadModel(m.name, m.engine === 'coding' ? CODING_ENGINE_BASE : undefined)))
  await audit(c.get('user').id, 'engine_unload', { model: '*', count: status.models.length })
  return c.json({ ok: true, unloaded: status.models.length })
})

// Clean restart of the local engines: main is killed by port + orphan-swept + respawned with
// current guards; the coding engine is stopped and respawns on the next coding session.
adminGpu.post('/restart-engine', async (c) => {
  await audit(c.get('user').id, 'engine_restart')
  await stopCodingEngine()
  await restartOllamaServe()
  return c.json({ ok: true })
})

// Manual orphan sweep (the watchdog also runs this every 60 s).
adminGpu.post('/sweep-orphans', async (c) => {
  const pids = await sweepOrphanLlamaRunners('admin-action')
  await audit(c.get('user').id, 'engine_sweep', { swept: pids.length })
  return c.json({ ok: true, swept: pids })
})

export { adminGpu }
