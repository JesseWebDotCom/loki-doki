import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getUserProfileSlug, getProfile, getDefaultProfileSlug, MIN_DIALS, DIAL_LEVELS } from '@/lib/contentPolicy'
import type { AppEnv } from '@/types'

const content = new Hono<AppEnv>()

// The ceiling for the settings editor = the dials of the user's assigned content
// profile, so the UI offers exactly the levels they're allowed to pick (a user on
// Locked Down sees only the lowest level on every category).
//
// This is intentionally the PROFILE cap, not getUserCeiling() — the latter folds in
// the user's own self-lowered `content_dials`, which is correct for runtime clamping
// but wrong here: it would collapse the ceiling onto the user's current picks, turning
// the dials into a one-way ratchet that can only ever go down and never back up.
content.get('/ceiling', requireAuth, async (c) => {
  const user = c.get('user')
  const profileSlug = await getUserProfileSlug(user.id)
  const profile = (await getProfile(profileSlug)) ?? (await getProfile(await getDefaultProfileSlug()))
  const ceiling = profile ? profile.dials : { ...MIN_DIALS }
  return c.json({ ceiling, levels: DIAL_LEVELS, profile: profile ? { slug: profile.slug, name: profile.name } : null })
})

export { content }
