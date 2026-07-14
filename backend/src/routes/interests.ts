// "Not interested" for suggestion rails: dismiss hard-excludes a ref from every future
// pool serve and penalizes its creator at the next profile build; undismiss backs the
// action out (the card's Undo toast). Domain-agnostic — one endpoint pair serves all
// five suggestion rails.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { dismiss, undismiss } from '@/lib/interests/impressions'
import type { InterestDomain } from '@/lib/interests/types'
import type { AppEnv } from '@/types'

const DOMAINS: ReadonlySet<string> = new Set(['videos', 'shows', 'movies', 'podcasts', 'music'])

interface DismissBody {
  domain?: string
  ref?: string
  creatorId?: string | null
  creatorName?: string | null
  title?: string | null
}

const interestsRoute = new Hono<AppEnv>()
interestsRoute.use('*', requireAuth)

interestsRoute.post('/dismiss', async (c) => {
  const body = await c.req.json<DismissBody>().catch(() => ({}) as DismissBody)
  const { domain, ref } = body
  if (!domain || !DOMAINS.has(domain) || !ref?.trim()) return c.json({ error: 'domain and ref required' }, 400)
  await dismiss(c.get('user').id, domain as InterestDomain, ref.trim(), {
    creatorId: body.creatorId ?? null,
    creatorName: body.creatorName ?? null,
    title: body.title ?? null,
  })
  return c.json({ ok: true })
})

interestsRoute.post('/undismiss', async (c) => {
  const body = await c.req.json<DismissBody>().catch(() => ({}) as DismissBody)
  const { domain, ref } = body
  if (!domain || !DOMAINS.has(domain) || !ref?.trim()) return c.json({ error: 'domain and ref required' }, 400)
  await undismiss(c.get('user').id, domain as InterestDomain, ref.trim())
  return c.json({ ok: true })
})

export { interestsRoute }
