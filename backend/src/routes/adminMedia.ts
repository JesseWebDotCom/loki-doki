// Admin-facing media settings — currently the household-wide "enhance downloaded videos by
// default" toggle. Deliberately app-neutral (not under /youtube): the enhance policy governs
// every download app. GET is auth-only (any user reads the default to resolve their own mode);
// PUT is admin-only.

import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { setAppSetting } from '@/lib/settings'
import { getEnhanceDefault, ENHANCE_DEFAULT_KEY } from '@/lib/media/enhancePolicy'
import { resolveVideoEncoder } from '@/lib/media/encoder'
import type { AppEnv } from '@/types'

const adminMedia = new Hono<AppEnv>()

adminMedia.get('/enhance-default', requireAuth, async (c) => {
  return c.json({ enabled: await getEnhanceDefault() })
})

adminMedia.put('/enhance-default', requireAdmin, async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>()
  await setAppSetting(ENHANCE_DEFAULT_KEY, enabled === true)
  // Warm the encoder in the background the moment enhancement is switched on: resolveVideoEncoder
  // triggers ensureNvencFfmpeg on NVIDIA boxes (fetching the NVENC-capable managed ffmpeg build)
  // or ensureFfmpeg elsewhere, so the first saved video's enhance job doesn't wait on a download.
  if (enabled === true) void resolveVideoEncoder().catch(() => {})
  return c.json({ enabled: enabled === true })
})

export { adminMedia }
