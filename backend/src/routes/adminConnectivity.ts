import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { invalidateGlobalModeCache, invalidateAllowDownloadsCache } from '@/lib/connectivity'
import type { AppEnv } from '@/types'

const adminConnectivity_ = new Hono<AppEnv>()

adminConnectivity_.get('/', requireAdmin, async (c) => {
  const [globalModeRaw, allowDownloadsRaw] = await Promise.all([
    getAppSetting('connectivity.global_mode'),
    getAppSetting('connectivity.allow_downloads'),
  ])
  return c.json({
    globalMode: globalModeRaw === 'offline' ? 'offline' : 'online',
    allowDownloads: allowDownloadsRaw === 'true',
  })
})

adminConnectivity_.put('/', requireAdmin, async (c) => {
  const body = await c.req.json<{ globalMode?: string; allowDownloads?: boolean }>()

  if (body.globalMode !== undefined) {
    if (body.globalMode !== 'online' && body.globalMode !== 'offline') {
      return c.json({ error: 'Invalid globalMode' }, 400)
    }
    await setAppSetting('connectivity.global_mode', body.globalMode)
    invalidateGlobalModeCache()
  }

  if (body.allowDownloads !== undefined) {
    await setAppSetting('connectivity.allow_downloads', body.allowDownloads ? 'true' : 'false')
    invalidateAllowDownloadsCache()
  }

  return c.json({ ok: true })
})

export { adminConnectivity_ as adminConnectivity }
