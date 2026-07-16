import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { appSettings } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { FEATURES, isFeatureEnabled } from '@/lib/featureGate'
import { shutdownCodingSidecar } from '@/lib/codingPtySidecar'
import { killSandboxedOrphans } from '@/lib/codingSandboxUser'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

// App/capability feature flags, stored in app_settings under `app_feature.<id>` and enforced
// at the backend boundary by lib/featureGate.ts (requireFeature / isFeatureEnabled). The
// registry (FEATURES) is the single source of truth for the set of ids and their defaults.
// This router is just the read/toggle API over that store. (See featureGate.ts for the note
// on why globals currently default ON pending a Security Controls UI.)

const appFeaturesRouter = new Hono<AppEnv>()

// Any authenticated user can read the effective on/off map (the sidebar needs it).
appFeaturesRouter.get('/', requireAuth, async (c) => {
  const rows = await db.select().from(appSettings)
  const stored = new Map<string, boolean>()
  for (const row of rows) {
    if (!row.key.startsWith('app_feature.')) continue
    try { stored.set(row.key.replace('app_feature.', ''), JSON.parse(row.value) as boolean) } catch { /* ignore */ }
  }
  const map: Record<string, boolean> = {}
  // Every registered feature reports its effective state (stored value or registry default)…
  for (const id of Object.keys(FEATURES)) map[id] = stored.get(id) ?? FEATURES[id]!.defaultEnabled
  // …plus any legacy/extra app_feature.* rows not in the registry, so nothing regresses.
  for (const [id, val] of stored) if (!(id in map)) map[id] = val
  return c.json(map)
})

// Admin-only: capability metadata (risk, label, description) for the Security Controls UI.
appFeaturesRouter.get('/meta', requireAdmin, async (c) => {
  const meta = await Promise.all(
    Object.values(FEATURES).map(async (f) => ({ ...f, enabled: await isFeatureEnabled(f.id) })),
  )
  return c.json(meta)
})

// Admin-only: toggle a feature on or off.
appFeaturesRouter.put('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  if (!(id in FEATURES)) return c.json({ error: 'Unknown feature' }, 400)

  const { enabled } = await c.req.json() as { enabled: boolean }
  const key = `app_feature.${id}`
  const user = c.get('user')

  const existing = await db.select().from(appSettings).where(eq(appSettings.key, key))
  if (existing.length > 0) {
    await db.update(appSettings)
      .set({ value: JSON.stringify(enabled), updatedAt: new Date() })
      .where(eq(appSettings.key, key))
  } else {
    await db.insert(appSettings).values({
      id: crypto.randomUUID(), key, value: JSON.stringify(enabled), updatedAt: new Date(),
    })
  }
  // Audit trail for enabling/disabling a capability (esp. the critical ones).
  logger.info(`[featureGate] ${enabled ? 'ENABLED' : 'DISABLED'} feature '${id}' by admin=${user?.id ?? 'unknown'}`)

  // Disabling Coding actively tears down the live terminals, not just the routes:
  // the gate blocks NEW attaches, but running claude sessions (and their persistent
  // ptys in the sidecar) would otherwise keep executing indefinitely.
  if (id === 'coding' && !enabled) {
    void shutdownCodingSidecar().catch((e) => logger.warn(`[featureGate] coding sidecar shutdown failed: ${e instanceof Error ? e.message : String(e)}`))
    // mac/Linux: the claude processes live in tmux panes as the sandbox user, outside
    // the sidecar — sweep those too (no-op on Windows / when the sandbox isn't installed).
    try { killSandboxedOrphans() } catch { /* best-effort */ }
  }

  return c.json({ id, enabled })
})

export { appFeaturesRouter as appFeatures }
