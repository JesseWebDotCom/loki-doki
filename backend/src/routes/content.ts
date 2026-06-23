import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getUserCeiling, getUserProfileSlug, getProfile, DIAL_LEVELS } from '@/lib/contentPolicy'
import type { AppEnv } from '@/types'

const content = new Hono<AppEnv>()

// The effective ceiling for THIS user = their assigned content profile's dials, so the
// settings UI only offers levels they're actually allowed to pick (a user on the
// Locked Down profile sees only the lowest level on every category).
content.get('/ceiling', requireAuth, async (c) => {
  const user = c.get('user')
  const [ceiling, profileSlug] = await Promise.all([getUserCeiling(user.id), getUserProfileSlug(user.id)])
  const profile = await getProfile(profileSlug)
  return c.json({ ceiling, levels: DIAL_LEVELS, profile: profile ? { slug: profile.slug, name: profile.name } : null })
})

export { content }
