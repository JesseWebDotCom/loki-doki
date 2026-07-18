import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import {
  applyEgressFence,
  egressFenceActive,
  fencePlatformSupport,
  getEgressFenceConfig,
  planEgressFence,
  removeEgressFence,
  setEgressFenceConfig,
  type EgressFenceConfig,
  type EgressFenceMode,
} from '@/lib/codingSandboxFirewall'

// Admin control for the opt-in coding-sandbox egress fence. All routes are admin-only;
// applying/removing runs privileged OS firewall commands (nftables / Windows Firewall).
const adminCodingFence = new Hono<AppEnv>()

function coerce(body: Partial<EgressFenceConfig>, current: EgressFenceConfig): EgressFenceConfig {
  const mode: EgressFenceMode = body.mode === 'deny-all' ? 'deny-all' : body.mode === 'lan-block' ? 'lan-block' : current.mode
  return {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    mode,
    allowlist: Array.isArray(body.allowlist)
      ? body.allowlist.filter((e): e is string => typeof e === 'string').map((e) => e.trim()).filter(Boolean).slice(0, 64)
      : current.allowlist,
  }
}

// GET /api/admin/coding-fence — config, platform support, and whether a fence is live.
adminCodingFence.get('/', requireAdmin, async (c) => {
  const [config, active] = await Promise.all([getEgressFenceConfig(), egressFenceActive()])
  return c.json({ config, support: fencePlatformSupport(), active })
})

// POST /api/admin/coding-fence/plan — dry run: the exact privileged commands, no changes.
adminCodingFence.post('/plan', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<EgressFenceConfig>
  const cfg = coerce(body, await getEgressFenceConfig())
  return c.json({ plan: await planEgressFence(cfg) })
})

// PUT /api/admin/coding-fence — persist config, then apply or remove to match.
adminCodingFence.put('/', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<EgressFenceConfig>
  const cfg = coerce(body, await getEgressFenceConfig())

  const support = fencePlatformSupport()
  if (cfg.enabled && !support.supported) {
    return c.json({ error: support.reason ?? 'The egress fence is not supported on this platform.' }, 400)
  }
  if (cfg.enabled && !support.modes.includes(cfg.mode)) {
    return c.json({ error: support.reason ?? `Mode "${cfg.mode}" is not supported on this platform.` }, 400)
  }

  await setEgressFenceConfig(cfg)
  const result = cfg.enabled ? await applyEgressFence(cfg) : await removeEgressFence()
  const active = await egressFenceActive()
  return c.json({ config: cfg, result, active })
})

export { adminCodingFence }
