// Family audio: the signed-in profile's own guardrail status. Polled by the players
// (frontend/src/hooks/useFamilyAudio.ts) to clamp volume, show the remaining-time chip,
// warn near the budget, and stop gracefully when the gate closes. Enforcement itself is
// server-side at the playback endpoints; this is the cooperative UX channel.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { audioGateFor, familyEntrySetsFor } from '@/lib/family/audioPolicy'
import type { AppEnv } from '@/types'

export const familyAudio = new Hono<AppEnv>()
familyAudio.use('*', requireAuth)

// GET /api/family-audio/me
familyAudio.get('/me', async (c) => {
  const user = c.get('user')
  const [gate, sets] = await Promise.all([audioGateFor(user.id), familyEntrySetsFor(user.id)])
  return c.json({
    allowed: gate.allowed,
    reason: gate.reason,
    remainingMinutes: gate.remainingMinutes,
    usedMinutesToday: gate.usedMinutesToday,
    allowlistOnly: gate.allowlistOnly,
    maxVolumePercent: gate.maxVolumePercent,
    quietHoursStart: gate.quietHoursStart,
    quietHoursEnd: gate.quietHoursEnd,
    restricted: gate.allowlistOnly || sets.block.length > 0
      || gate.remainingMinutes != null || gate.quietHoursStart != null || gate.maxVolumePercent != null,
  })
})
