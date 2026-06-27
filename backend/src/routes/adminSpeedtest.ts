import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import type { AppEnv } from '@/types'

export interface SpeedTestAdminSettings {
  goodMbps: number
  okMbps: number
}

const DEFAULTS: SpeedTestAdminSettings = { goodMbps: 50, okMbps: 10 }

let _cache: SpeedTestAdminSettings | null = null

export async function getSpeedTestThresholds(): Promise<SpeedTestAdminSettings> {
  if (_cache) return _cache
  const [goodRaw, okRaw] = await Promise.all([
    getAppSetting('speedtest.threshold_good'),
    getAppSetting('speedtest.threshold_ok'),
  ])
  _cache = {
    goodMbps: typeof goodRaw === 'number' ? goodRaw : DEFAULTS.goodMbps,
    okMbps: typeof okRaw === 'number' ? okRaw : DEFAULTS.okMbps,
  }
  return _cache
}

function invalidateCache() { _cache = null }

const adminSpeedtest = new Hono<AppEnv>()

adminSpeedtest.get('/', requireAuth, async (c) => {
  return c.json(await getSpeedTestThresholds())
})

adminSpeedtest.put('/', requireAdmin, async (c) => {
  const body = await c.req.json<Partial<SpeedTestAdminSettings>>()
  if (typeof body.goodMbps === 'number' && body.goodMbps >= 0) {
    await setAppSetting('speedtest.threshold_good', body.goodMbps)
  }
  if (typeof body.okMbps === 'number' && body.okMbps >= 0) {
    await setAppSetting('speedtest.threshold_ok', body.okMbps)
  }
  invalidateCache()
  return c.json(await getSpeedTestThresholds())
})

export { adminSpeedtest }
