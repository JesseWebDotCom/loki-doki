// Admin -> Content & Safety -> Network: DNS filtering config, blocklist downloads,
// per-device profiles, custom allow/deny rules, and live stats.

import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { dnsDevices, dnsRules } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import {
  BLOCKLIST_CATEGORIES, blocklistCount, downloadBlocklist, isBlocklistDownloaded,
} from '@/lib/dns/blocklist'
import {
  dnsBindError, getDnsConfig, isDnsRunning, reloadDns, setDnsConfig, type DnsConfig,
} from '@/lib/dns/server'

const app = new Hono()
app.use('*', requireAdmin)

app.get('/', async (c) => {
  const config = await getDnsConfig()
  const devices = await db.select().from(dnsDevices).orderBy(desc(dnsDevices.lastSeenAt)).limit(100)
  const rules = await db.select().from(dnsRules).orderBy(desc(dnsRules.createdAt))
  return c.json({
    config,
    running: isDnsRunning(),
    bindError: dnsBindError(),
    categories: BLOCKLIST_CATEGORIES.map((cat) => ({
      ...cat,
      downloaded: isBlocklistDownloaded(cat.id),
      count: blocklistCount(cat.id),
    })),
    devices,
    rules,
  })
})

app.put('/config', async (c) => {
  const body = await c.req.json().catch(() => null) as Partial<DnsConfig> | null
  if (!body) return c.json({ ok: false, error: 'Invalid request body.' }, 400)
  const current = await getDnsConfig()
  const known = new Set(BLOCKLIST_CATEGORIES.map((cat) => cat.id))
  const clean = (ids: unknown, fallback: string[]) =>
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && known.has(id)) : fallback
  const next: DnsConfig = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    port: typeof body.port === 'number' && body.port > 0 && body.port < 65536 ? Math.round(body.port) : current.port,
    upstreams: Array.isArray(body.upstreams)
      ? body.upstreams.filter((u): u is string => typeof u === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(u))
      : current.upstreams,
    categories: clean(body.categories, current.categories),
    kidsCategories: clean(body.kidsCategories, current.kidsCategories),
  }
  if (next.upstreams.length === 0) return c.json({ ok: false, error: 'At least one upstream resolver is required.' }, 400)
  await setDnsConfig(next)
  const result = await reloadDns()
  return c.json({ ok: true, config: next, running: isDnsRunning(), bindError: result.error ?? dnsBindError() })
})

app.post('/blocklist/:id/download', async (c) => {
  const cat = BLOCKLIST_CATEGORIES.find((x) => x.id === c.req.param('id'))
  if (!cat) return c.json({ ok: false, error: 'Unknown blocklist.' }, 404)
  const result = await downloadBlocklist(cat)
  if (result.ok) await reloadDns()
  return c.json(result, result.ok ? 200 : 400)
})

app.put('/device/:ip', async (c) => {
  const ip = c.req.param('ip')
  const body = await c.req.json().catch(() => null) as { label?: string; profile?: string } | null
  if (!body) return c.json({ ok: false, error: 'Invalid request body.' }, 400)
  const profile = ['default', 'kids', 'unfiltered'].includes(body.profile ?? '') ? body.profile! : undefined
  const patch: Partial<typeof dnsDevices.$inferInsert> = {}
  if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim().slice(0, 60)
  if (profile) patch.profile = profile
  if (Object.keys(patch).length === 0) return c.json({ ok: false, error: 'Nothing to update.' }, 400)
  await db.update(dnsDevices).set(patch).where(eq(dnsDevices.ip, ip))
  await reloadDns()
  return c.json({ ok: true })
})

app.post('/rule', async (c) => {
  const body = await c.req.json().catch(() => null) as { domain?: string; action?: string } | null
  const domain = body?.domain?.trim().toLowerCase()
  if (!domain || !domain.includes('.')) return c.json({ ok: false, error: 'Enter a valid domain.' }, 400)
  const action = body?.action === 'allow' ? 'allow' : 'deny'
  await db.insert(dnsRules).values({ id: crypto.randomUUID(), domain, action, profile: null, createdAt: new Date() })
  await reloadDns()
  return c.json({ ok: true })
})

app.delete('/rule/:id', async (c) => {
  await db.delete(dnsRules).where(eq(dnsRules.id, c.req.param('id')))
  await reloadDns()
  return c.json({ ok: true })
})

export default app
