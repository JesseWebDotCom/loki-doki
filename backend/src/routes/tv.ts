// Doki TV: linear channels API (plans/doki-tv.md).
// In-app surface (cookie auth): channel list, now-playing resolution, EPG guide.
// IPTV surface (token auth, for Plex-via-Threadfin / Jellyfin / any IPTV client):
// M3U playlist + XMLTV guide + channel logos + continuous MPEG-TS streams.

import { Hono } from 'hono'
import { and, asc, eq, gt, gte, lt, lte } from 'drizzle-orm'
import { db } from '@/db'
import { tvChannels, tvSchedule, tvSegments } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { timingSafeEqual, createHash } from 'node:crypto'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { channelLogoSvg, channelLogoPng, type TvLogoSpec } from '@/lib/tv/logos'
import { sanitizeTvChannelConfig, sanitizeTvChannelName } from '@/lib/tv/validate'
import { rebuildChannelSchedule, extendChannelSchedule, ensureTvSchedules, seedTvChannels } from '@/lib/tv/scheduler'
import { openChannelTsStream } from '@/lib/tv/streamSession'
import type { TvBlockPayload, TvChannelConfig, TvChannelInfo } from '@/lib/tv/types'
import type { AppEnv } from '@/types'

export const tvRoute = new Hono<AppEnv>()

type ChannelRow = typeof tvChannels.$inferSelect

function channelInfo(row: ChannelRow): TvChannelInfo {
  return {
    id: row.id, number: row.number, slug: row.slug, name: row.name, tagline: row.tagline,
    kind: row.kind, glyph: row.glyph, color: row.color, colorDark: row.colorDark,
    audience: row.audience, enabled: row.enabled,
    config: JSON.parse(row.config) as TvChannelConfig,
  }
}

function blockWire(row: typeof tvSchedule.$inferSelect) {
  return {
    id: row.id,
    startAt: row.startAt.getTime(),
    endAt: row.endAt.getTime(),
    blockKind: row.blockKind,
    title: row.title,
    subtitle: row.subtitle,
    art: row.art,
    payload: JSON.parse(row.payload) as TvBlockPayload,
  }
}

async function enabledChannels(): Promise<ChannelRow[]> {
  return db.select().from(tvChannels).where(eq(tvChannels.enabled, true)).orderBy(asc(tvChannels.number))
}

// ── IPTV token (external guide clients cannot send session cookies) ──────────────

async function iptvToken(): Promise<string> {
  const existing = await getAppSetting('tv.iptvToken')
  if (typeof existing === 'string' && existing.length >= 32) return existing
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  await setAppSetting('tv.iptvToken', token)
  return token
}

async function checkIptvToken(given: string | undefined): Promise<boolean> {
  if (!given) return false
  const token = await getAppSetting('tv.iptvToken')
  if (typeof token !== 'string' || token.length < 32) return false
  // Compare digests so length differences and early mismatches leak no timing signal.
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

// ── In-app API ───────────────────────────────────────────────────────────────────

tvRoute.get('/channels', requireAuth, async (c) => {
  const rows = await enabledChannels()
  return c.json({ channels: rows.map(channelInfo) })
})

/** What a channel is showing right now (plus what is next). Tune-in resolution. */
tvRoute.get('/channels/:slug/now', requireAuth, async (c) => {
  const slug = c.req.param('slug')
  const rows = await db.select().from(tvChannels).where(eq(tvChannels.slug, slug)).limit(1)
  const channel = rows[0]
  if (!channel || !channel.enabled) return c.json({ error: 'Channel not found' }, 404)

  const fetchNow = async () => {
    const now = new Date()
    const current = await db.select().from(tvSchedule)
      .where(and(eq(tvSchedule.channelId, channel.id), lte(tvSchedule.startAt, now), gt(tvSchedule.endAt, now)))
      .orderBy(asc(tvSchedule.startAt)).limit(1)
    return current[0] ?? null
  }

  let block = await fetchNow()
  if (!block) {
    // Fresh boot or schedule gap: extend on demand, once.
    await extendChannelSchedule(channel.id)
    block = await fetchNow()
  }
  if (!block) return c.json({ channel: channelInfo(channel), block: null, next: [] })

  const next = await db.select().from(tvSchedule)
    .where(and(eq(tvSchedule.channelId, channel.id), gte(tvSchedule.startAt, block.endAt)))
    .orderBy(asc(tvSchedule.startAt)).limit(3)

  return c.json({
    channel: channelInfo(channel),
    block: { ...blockWire(block), offsetSec: Math.max(0, (Date.now() - block.startAt.getTime()) / 1000) },
    next: next.map(blockWire),
  })
})

/** EPG grid: every enabled channel's blocks in a window (default now-30min to now+4h). */
tvRoute.get('/guide', requireAuth, async (c) => {
  const rawHours = Number(c.req.query('hours') ?? 4)
  const hours = Number.isFinite(rawHours) ? Math.min(24, Math.max(1, rawHours)) : 4
  const from = new Date(Date.now() - 30 * 60 * 1000)
  const to = new Date(Date.now() + hours * 60 * 60 * 1000)
  const channels = await enabledChannels()
  const blocks = await db.select().from(tvSchedule)
    .where(and(gt(tvSchedule.endAt, from), lt(tvSchedule.startAt, to)))
    .orderBy(asc(tvSchedule.startAt))
  const byChannel = new Map<string, ReturnType<typeof blockWire>[]>()
  for (const b of blocks) {
    const list = byChannel.get(b.channelId) ?? []
    list.push(blockWire(b))
    byChannel.set(b.channelId, list)
  }
  return c.json({
    from: from.getTime(),
    to: to.getTime(),
    channels: channels.map((ch) => ({ ...channelInfo(ch), blocks: byChannel.get(ch.id) ?? [] })),
  })
})

tvRoute.get('/logo/:slug', requireAuth, async (c) => {
  const slug = c.req.param('slug').replace(/\.(svg|png)$/, '')
  const rows = await db.select().from(tvChannels).where(eq(tvChannels.slug, slug)).limit(1)
  const ch = rows[0]
  if (!ch) return c.json({ error: 'Channel not found' }, 404)
  const svg = channelLogoSvg({ slug: ch.slug, name: ch.name, number: ch.number, color: ch.color, colorDark: ch.colorDark })
  return c.body(svg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=86400' })
})

/** Serve a pre-rendered segment file (Range-aware) for the in-app player. */
tvRoute.get('/segments/:id/video', requireAuth, async (c) => {
  const rows = await db.select().from(tvSegments).where(eq(tvSegments.id, c.req.param('id'))).limit(1)
  const seg = rows[0]
  if (!seg?.path || seg.status !== 'ready') return c.json({ error: 'Segment not available' }, 404)
  const { createReadStream, existsSync } = await import('node:fs')
  const { stat } = await import('node:fs/promises')
  const { isAbsolute, join } = await import('node:path')
  const filePath = isAbsolute(seg.path) ? seg.path : join(process.cwd(), 'data', seg.path)
  if (!existsSync(filePath)) return c.json({ error: 'Segment file missing' }, 404)
  const info = await stat(filePath)
  const range = c.req.header('range')
  // Both range forms: bytes=start-[end] and the suffix form bytes=-N.
  const m = range?.match(/^bytes=(\d*)-(\d*)$/)
  let start = 0
  let end = info.size - 1
  let partial = false
  if (m && (m[1] !== '' || m[2] !== '')) {
    partial = true
    if (m[1] === '') {
      const suffix = Math.min(Number(m[2]), info.size)
      start = info.size - suffix
    } else {
      start = Number(m[1])
      if (m[2] !== '') end = Math.min(Number(m[2]), info.size - 1)
    }
    if (start >= info.size || start > end) {
      return c.body(null, 416, { 'Content-Range': `bytes */${info.size}` })
    }
  }
  const { Readable } = await import('node:stream')
  const nodeStream = createReadStream(filePath, { start, end })
  const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
  return c.body(body, partial ? 206 : 200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
  })
})

// ── Admin ────────────────────────────────────────────────────────────────────────

tvRoute.get('/admin/channels', requireAdmin, async (c) => {
  const rows = await db.select().from(tvChannels).orderBy(asc(tvChannels.number))
  return c.json({ channels: rows.map(channelInfo) })
})

tvRoute.put('/admin/channels/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ enabled?: boolean; name?: string; tagline?: string; config?: TvChannelConfig }>()
  const rows = await db.select().from(tvChannels).where(eq(tvChannels.id, id)).limit(1)
  if (!rows[0]) return c.json({ error: 'Channel not found' }, 404)
  // A config edit must not change the channel's kind: builders trust config.kind.
  if (body.config && body.config.kind !== rows[0].kind) {
    return c.json({ error: 'Channel kind cannot change' }, 400)
  }
  await db.update(tvChannels).set({
    ...(body.enabled != null ? { enabled: body.enabled } : {}),
    ...(body.name ? { name: sanitizeTvChannelName(body.name) } : {}),
    ...(body.tagline != null ? { tagline: sanitizeTvChannelName(body.tagline) } : {}),
    ...(body.config ? { config: JSON.stringify(sanitizeTvChannelConfig(body.config)) } : {}),
    updatedAt: new Date(),
  }).where(eq(tvChannels.id, id))
  await rebuildChannelSchedule(id)
  return c.json({ ok: true })
})

tvRoute.post('/admin/rebuild', requireAdmin, async (c) => {
  await seedTvChannels()
  await db.delete(tvSchedule).where(gt(tvSchedule.startAt, new Date()))
  await ensureTvSchedules()
  return c.json({ ok: true })
})

/** Everything an admin needs to point Jellyfin/Threadfin (and through it, Plex) at us. */
tvRoute.get('/admin/iptv-info', requireAdmin, async (c) => {
  const token = await iptvToken()
  const origin = new URL(c.req.url).origin
  return c.json({
    token,
    m3uUrl: `${origin}/api/tv/iptv/playlist.m3u?token=${token}`,
    xmltvUrl: `${origin}/api/tv/iptv/guide.xml?token=${token}`,
  })
})

// ── IPTV surface (token-gated; no cookies) ──────────────────────────────────────

tvRoute.get('/iptv/playlist.m3u', async (c) => {
  if (!(await checkIptvToken(c.req.query('token')))) return c.text('Forbidden', 403)
  const token = c.req.query('token')
  const origin = new URL(c.req.url).origin
  const channels = await enabledChannels()
  const lines = ['#EXTM3U']
  for (const ch of channels) {
    // Names are sanitized on write, but strip line breaks here too: a newline in a
    // name would inject playlist lines for rows predating validation.
    const name = ch.name.replace(/[\r\n"]+/g, ' ').trim()
    lines.push(
      `#EXTINF:-1 tvg-id="${ch.slug}" tvg-chno="${ch.number}" tvg-name="${name}" ` +
      `tvg-logo="${origin}/api/tv/iptv/logo/${ch.slug}.png?token=${token}" group-title="Doki TV",${ch.number} ${name}`,
      `${origin}/api/tv/iptv/stream/${ch.slug}.ts?token=${token}`,
    )
  }
  return c.body(lines.join('\n') + '\n', 200, { 'Content-Type': 'audio/x-mpegurl' })
})

function xmltvTime(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

tvRoute.get('/iptv/guide.xml', async (c) => {
  if (!(await checkIptvToken(c.req.query('token')))) return c.text('Forbidden', 403)
  const token = c.req.query('token')
  const origin = new URL(c.req.url).origin
  const channels = await enabledChannels()
  const from = new Date(Date.now() - 60 * 60 * 1000)
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Loki Doki - Doki TV">']
  for (const ch of channels) {
    parts.push(
      `  <channel id="${xmlEsc(ch.slug)}">`,
      `    <display-name>${xmlEsc(`${ch.number} ${ch.name}`)}</display-name>`,
      `    <display-name>${xmlEsc(ch.name)}</display-name>`,
      `    <icon src="${origin}/api/tv/iptv/logo/${ch.slug}.png?token=${token}"/>`,
      '  </channel>',
    )
  }
  for (const ch of channels) {
    const blocks = await db.select().from(tvSchedule)
      .where(and(eq(tvSchedule.channelId, ch.id), gt(tvSchedule.endAt, from), lt(tvSchedule.startAt, to)))
      .orderBy(asc(tvSchedule.startAt))
    for (const b of blocks) {
      parts.push(
        `  <programme start="${xmltvTime(b.startAt.getTime())}" stop="${xmltvTime(b.endAt.getTime())}" channel="${xmlEsc(ch.slug)}">`,
        `    <title>${xmlEsc(b.title)}</title>`,
        ...(b.subtitle ? [`    <desc>${xmlEsc(b.subtitle)}</desc>`] : []),
        '  </programme>',
      )
    }
  }
  parts.push('</tv>')
  return c.body(parts.join('\n') + '\n', 200, { 'Content-Type': 'application/xml' })
})

tvRoute.get('/iptv/logo/:slug', async (c) => {
  if (!(await checkIptvToken(c.req.query('token')))) return c.text('Forbidden', 403)
  const wantsPng = c.req.param('slug').endsWith('.png')
  const slug = c.req.param('slug').replace(/\.(svg|png)$/, '')
  const rows = await db.select().from(tvChannels).where(eq(tvChannels.slug, slug)).limit(1)
  const ch = rows[0]
  if (!ch) return c.text('Not found', 404)
  const spec: TvLogoSpec = { slug: ch.slug, name: ch.name, number: ch.number, color: ch.color, colorDark: ch.colorDark }
  if (wantsPng) {
    const png = await channelLogoPng(spec)
    if (png) return c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
  }
  return c.body(channelLogoSvg(spec), 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' })
})

tvRoute.get('/iptv/stream/:slug', async (c) => {
  if (!(await checkIptvToken(c.req.query('token')))) return c.text('Forbidden', 403)
  const slug = c.req.param('slug').replace(/\.ts$/, '')
  // The session cap is claimed inside openChannelTsStream (synchronously, so parallel
  // requests cannot overshoot it); no separate check here that could race.
  const stream = await openChannelTsStream(slug)
  if (stream === 'capacity') return c.text('Too many active TV streams', 503)
  if (!stream) return c.text('Channel not found', 404)
  return c.body(stream, 200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' })
})
