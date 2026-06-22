import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { isOffline } from '@/lib/connectivity'
import { resolveToolConfig } from '@/lib/toolConfig'
import { localEventsTool } from '@/tools/localEvents'
import type { AppEnv } from '@/types'

const localEventsRoute = new Hono<AppEnv>()

interface EventItem {
  text: string
  url?: string
}

// Simple in-memory cache: key → { events, location, source, expiresAt }
const cache = new Map<string, { events: EventItem[]; location: string | null; source: 'patch' | 'web'; expiresAt: number }>()
const TTL_MS = 15 * 60 * 1000

interface RawEvent {
  title: string
  url?: string
  detail?: string
}

localEventsRoute.get('/', requireAuth, async (c) => {
  const user = c.get('user')

  if (await isOffline(user.id)) {
    return c.json({ events: [], location: null, offline: true })
  }

  const cacheKey = `local-events-${user.id}`
  const bust = c.req.query('bust') === '1'
  const cached = cache.get(cacheKey)
  if (!bust && cached && Date.now() < cached.expiresAt) {
    return c.json({ events: cached.events, location: cached.location, source: cached.source, offline: false })
  }

  const config = await resolveToolConfig('localEvents', user.id)
  config['_userId'] = user.id

  // Inject user.location preference (same as toolTurn.ts) so the page works
  // without needing a separate tool-config entry.
  if (!config['default_location']) {
    try {
      const [row] = await db
        .select({ value: userPreferences.value })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, 'user.location')))
        .limit(1)
      if (row) {
        const loc = JSON.parse(row.value) as { displayName?: string } | null
        if (loc?.displayName) config['default_location'] = loc.displayName
      }
    } catch { /* ignore */ }
  }

  const result = await localEventsTool.execute({}, config)

  const location = (config['default_location'] as string | undefined) ?? null

  if (!result.success) {
    return c.json({ events: [], location, source: 'web' as const, offline: false })
  }

  const data = result.data as Record<string, unknown> | undefined
  const source = (data?.['source'] === 'patch' ? 'patch' : 'web') as 'patch' | 'web'

  let events: EventItem[] = []

  // Prefer the structured events array if present (has URL info)
  if (Array.isArray(data?.['events'])) {
    events = (data['events'] as RawEvent[]).map((e) => ({
      text: e.detail ? `${e.title} — ${e.detail}` : e.title,
      ...(e.url ? { url: e.url } : {}),
    }))
  } else {
    // Fall back to answer_payload highlights + sources for URL matching
    const payload = data?.['answer_payload'] as Record<string, unknown> | undefined
    const highlights = payload?.['highlights']
    const sources = payload?.['sources'] as Array<{ url: string; title: string }> | undefined

    if (Array.isArray(highlights)) {
      events = (highlights as string[]).map((h) => {
        const match = sources?.find((s) => h.startsWith(s.title.slice(0, 30)))
        return { text: h, ...(match ? { url: match.url } : {}) }
      })
    }
  }

  cache.set(cacheKey, { events, location, source, expiresAt: Date.now() + TTL_MS })
  return c.json({ events, location, source, offline: false })
})

export { localEventsRoute }
