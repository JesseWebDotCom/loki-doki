// Admin API for model sets: list the sets with a switch plan (what downloads, what
// gets cleaned up, whether a re-embed is needed), and start a switch. The switch is
// asynchronous — pulls run through the background job queue and the flip happens in
// maybeFinalizeSetSwitch() once everything is installed; progress is visible in the
// standard download widget.
import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import { MODEL_SETS, catalogForTier, recommendedTier, type ModelSetId } from '@/lib/catalog'
import { detectHardware } from '@/lib/hwfit'
import {
  getActiveModelSet, getPendingModelSet, planSetSwitch, applySetSwitch,
} from '@/lib/modelSets'
import { db } from '@/db'
import { adminAuditLog } from '@/db/schema'
import type { AppEnv } from '@/types'

const adminModelSets = new Hono<AppEnv>()

// Same best-effort audit pattern as adminGpu.ts.
async function audit(userId: string, action: 'model_set_switch', detail?: unknown): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      id: crypto.randomUUID(), userId, action,
      detail: detail === undefined ? null : JSON.stringify(detail), createdAt: new Date(),
    })
  } catch { /* audit is best-effort */ }
}

function parseSetId(v: unknown): ModelSetId | null {
  return MODEL_SETS.find((s) => s.id === v)?.id ?? null
}

adminModelSets.get('/', requireAdmin, async (c) => {
  const hw = await detectHardware()
  const tier = recommendedTier(hw)
  const active = await getActiveModelSet()
  const pending = await getPendingModelSet()
  const sets = await Promise.all(MODEL_SETS.map(async (s) => ({
    ...s,
    models: catalogForTier(tier, s.id)
      .filter((m) => m.backend === 'ollama')
      .map((m) => ({ id: m.id, label: m.label, role: m.role, approxBytes: m.approxBytes, builtinVision: !!m.builtinVision })),
    plan: s.id === active && !pending ? null : await planSetSwitch(s.id),
  })))
  return c.json({ active, pending, tier, sets })
})

adminModelSets.post('/switch', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { set?: string }
  const target = parseSetId(body.set)
  if (!target) return c.json({ error: `Unknown model set: ${String(body.set)}` }, 400)

  const plan = await applySetSwitch(target)
  await audit(c.get('user').id, 'model_set_switch', {
    target,
    downloads: plan.toInstall.map((m) => m.id),
    removals: plan.toRemove.map((m) => m.id),
    embedderChanges: plan.embedderChanges,
  })
  const pending = await getPendingModelSet()
  return c.json({ ok: true, plan, pending, active: await getActiveModelSet() })
})

export { adminModelSets }
