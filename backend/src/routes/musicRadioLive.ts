// Live internet radio — saved-station library, live stream proxy, timed recordings.
//
// The proxy is mandatory, not an optimization: most stations still stream over http://
// (mixed-content-blocked on an https page), and only same-origin bytes let the EQ
// visualizer's analyser tap the audio element. The client never supplies a raw URL —
// a stream key is either a saved-station row id (owned by the user) or 'rb:<uuid>'
// resolved server-side via radio-browser (which is what makes preview-before-add safe).

import { Hono } from 'hono'
import { createReadStream, statSync } from 'node:fs'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { musicRadioRecordings, musicRadioStations } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { assertPublicUrl, safeFetch, SsrfError } from '@/lib/ssrfGuard'
import { enqueueRadioRecording } from '@/lib/downloadJobs'
import { isRecordingActive, stopRecording, unlinkRecordingFile } from '@/lib/music/radioRecord'
import { resolveUserPath } from '@/lib/storage/paths'
import { rbFetch } from '@/routes/musicRadio'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

export const musicRadioLive = new Hono<AppEnv>()
musicRadioLive.use('*', requireAuth)

const MAX_RECORD_MIN = 360

interface RbStationInput {
  stationuuid?: string
  name?: string
  url?: string
  homepage?: string | null
  favicon?: string | null
  tags?: string
  country?: string
  language?: string
  codec?: string
  bitrate?: number
}

// ── Saved stations (the user's radio library) ────────────────────────────────────

musicRadioLive.get('/library', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(musicRadioStations)
    .where(eq(musicRadioStations.userId, user.id))
    .orderBy(desc(musicRadioStations.createdAt))
  return c.json({ stations: rows })
})

musicRadioLive.post('/library', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ source?: 'radio-browser' | 'manual'; station?: RbStationInput; name?: string; streamUrl?: string }>()
    .catch(() => ({} as { source?: undefined }))

  let values: typeof musicRadioStations.$inferInsert
  if (body.source === 'radio-browser') {
    // Fields come from our own search proxy response — trust them as display metadata,
    // but the stream URL still gets the public-address check before we'll ever fetch it.
    const s = body.station
    if (!s?.url || !s.name) return c.json({ error: 'station with url and name required' }, 400)
    try { await assertPublicUrl(s.url) } catch { return c.json({ error: 'Stream URL is not reachable from here' }, 400) }
    values = {
      id: crypto.randomUUID(), userId: user.id, source: 'radio-browser',
      stationUuid: s.stationuuid ?? null, name: s.name, streamUrl: s.url,
      homepage: s.homepage || null, favicon: s.favicon || null, tags: s.tags || null,
      country: s.country || null, language: s.language || null,
      codec: s.codec || null, bitrate: s.bitrate ?? null, createdAt: new Date(),
    }
  } else if (body.source === 'manual') {
    const name = body.name?.trim()
    const streamUrl = body.streamUrl?.trim()
    if (!name || !streamUrl) return c.json({ error: 'name and streamUrl required' }, 400)
    const probe = await probeStream(streamUrl)
    if (!probe.ok) return c.json({ error: probe.error }, 400)
    values = {
      id: crypto.randomUUID(), userId: user.id, source: 'manual',
      stationUuid: null, name, streamUrl,
      homepage: null, favicon: null, tags: null, country: null, language: null,
      codec: probe.codec, bitrate: null, createdAt: new Date(),
    }
  } else {
    return c.json({ error: 'source must be radio-browser or manual' }, 400)
  }

  // Unique (userId, streamUrl): re-adding the same stream is a no-op, return the existing row.
  await db.insert(musicRadioStations).values(values).onConflictDoNothing()
  const [row] = await db.select().from(musicRadioStations)
    .where(and(eq(musicRadioStations.userId, user.id), eq(musicRadioStations.streamUrl, values.streamUrl)))
    .limit(1)
  return c.json({ station: row })
})

musicRadioLive.delete('/library/:id', async (c) => {
  const user = c.get('user')
  await db.delete(musicRadioStations)
    .where(and(eq(musicRadioStations.id, c.req.param('id')), eq(musicRadioStations.userId, user.id)))
  return c.json({ ok: true })
})

/** Validate a manually-entered stream URL: public address + audio-ish response headers.
 *  Reads headers only — the body is aborted immediately (this is a live stream). */
async function probeStream(streamUrl: string): Promise<{ ok: true; codec: string | null } | { ok: false; error: string }> {
  try {
    await assertPublicUrl(streamUrl)
  } catch (err) {
    return { ok: false, error: err instanceof SsrfError ? err.message : 'Invalid URL' }
  }
  if (/\.m3u8(\?|$)/i.test(streamUrl)) return { ok: false, error: 'HLS streams are not supported yet' }
  try {
    const res = await safeFetch(streamUrl, {
      headers: { 'User-Agent': 'LokiDoki/3.0 radio', Accept: '*/*' },
    }, { timeoutMs: 6000 })
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    const icy = [...res.headers.keys()].some(k => k.toLowerCase().startsWith('icy-'))
    res.body?.cancel().catch(() => {})
    if (ct.includes('mpegurl')) return { ok: false, error: 'HLS streams are not supported yet' }
    if (!res.ok) return { ok: false, error: `Stream responded ${res.status}` }
    if (!ct.startsWith('audio/') && !ct.startsWith('application/ogg') && !icy) {
      return { ok: false, error: `Not an audio stream (content-type: ${ct || 'unknown'})` }
    }
    const codec = ct.includes('mpeg') ? 'MP3' : ct.includes('aac') ? 'AAC' : ct.includes('ogg') ? 'OGG' : null
    return { ok: true, codec }
  } catch (err) {
    return { ok: false, error: err instanceof SsrfError ? err.message : 'Could not connect to stream' }
  }
}

// ── Live stream proxy ─────────────────────────────────────────────────────────────

/** Resolve a stream key to a URL the server may fetch. Saved row id → its frozen URL
 *  (ownership enforced); 'rb:<uuid>' → resolved live via radio-browser (preview-before-add). */
async function resolveStreamKey(key: string, userId: string): Promise<{ url: string; stationUuid: string | null } | null> {
  if (key.startsWith('rb:')) {
    const uuid = key.slice(3)
    if (!/^[0-9a-f-]{16,}$/i.test(uuid)) return null
    try {
      const res = await rbFetch(`stations/byuuid/${uuid}`)
      const rows = await res.json() as Array<{ url_resolved?: string; url?: string }>
      const url = rows?.[0]?.url_resolved || rows?.[0]?.url
      return url ? { url, stationUuid: uuid } : null
    } catch {
      return null
    }
  }
  const [row] = await db.select({ streamUrl: musicRadioStations.streamUrl, stationUuid: musicRadioStations.stationUuid })
    .from(musicRadioStations)
    .where(and(eq(musicRadioStations.id, key), eq(musicRadioStations.userId, userId)))
    .limit(1)
  return row ? { url: row.streamUrl, stationUuid: row.stationUuid } : null
}

musicRadioLive.get('/stream/:key', async (c) => {
  const user = c.get('user')
  const resolved = await resolveStreamKey(c.req.param('key'), user.id)
  if (!resolved) return c.json({ error: 'Unknown station' }, 404)

  let upstream: Response
  try {
    upstream = await safeFetch(resolved.url, {
      headers: { 'User-Agent': 'LokiDoki/3.0 radio', Accept: '*/*' },
      // No Icy-MetaData header: without it the server sends a clean byte stream
      // (no interleaved title blocks to strip).
    }, { timeoutMs: 10_000 })
  } catch (err) {
    logger.warn(`[radio] stream connect failed: ${err}`)
    return c.json({ error: 'Station is not responding' }, 502)
  }
  if (!upstream.ok || !upstream.body) {
    upstream.body?.cancel().catch(() => {})
    return c.json({ error: `Station responded ${upstream.status}` }, 502)
  }

  // Close the upstream ICY connection the moment the listener disconnects — an infinite
  // body never ends on its own, and leaked connections pile up per tune-in otherwise. A tab
  // closed during the (up to 10-30s) connect window already aborted the request signal; a
  // listener added now would never fire, so check first and cancel immediately.
  const body = upstream.body
  if (c.req.raw.signal.aborted) { body.cancel().catch(() => {}); return new Response(null, { status: 499 }) }
  c.req.raw.signal.addEventListener('abort', () => { body.cancel().catch(() => {}) }, { once: true })

  // radio-browser etiquette: report a listen so station popularity counts stay honest.
  if (resolved.stationUuid) {
    rbFetch(`url/${resolved.stationUuid}`).then(r => r.body?.cancel()).catch(() => {})
  }

  const ct = upstream.headers.get('content-type')
  return new Response(body, {
    headers: {
      'Content-Type': ct && ct.startsWith('audio/') || ct?.startsWith('application/ogg') ? ct : 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  })
})

// ── Timed recordings ──────────────────────────────────────────────────────────────

musicRadioLive.post('/recordings', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ stationId?: string; minutes?: number }>().catch(() => ({} as { stationId?: undefined }))
  if (!body.stationId) return c.json({ error: 'stationId required' }, 400)
  const minutes = Math.max(1, Math.min(Math.round(body.minutes ?? 30), MAX_RECORD_MIN))

  const [station] = await db.select().from(musicRadioStations)
    .where(and(eq(musicRadioStations.id, body.stationId), eq(musicRadioStations.userId, user.id)))
    .limit(1)
  if (!station) return c.json({ error: 'Unknown station' }, 404)

  const now = new Date()
  const title = `${station.name} — ${now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
  const recording: typeof musicRadioRecordings.$inferInsert = {
    id: crypto.randomUUID(), userId: user.id, stationId: station.id,
    stationName: station.name, streamUrl: station.streamUrl, codec: station.codec,
    title, requestedSec: minutes * 60, status: 'pending',
    createdAt: now, updatedAt: now,
  }
  await db.insert(musicRadioRecordings).values(recording)
  await enqueueRadioRecording(recording.id!, `Recording: ${station.name} (${minutes} min)`)
  const [row] = await db.select().from(musicRadioRecordings).where(eq(musicRadioRecordings.id, recording.id!)).limit(1)
  return c.json({ recording: row })
})

musicRadioLive.get('/recordings', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(musicRadioRecordings)
    .where(eq(musicRadioRecordings.userId, user.id))
    .orderBy(desc(musicRadioRecordings.createdAt))
  return c.json({ recordings: rows })
})

// Stop-and-keep: finalizes the file through the runner's normal finish path. This is NOT
// a job cancel (which is the discard path in the downloads widget).
musicRadioLive.post('/recordings/:id/stop', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select({ userId: musicRadioRecordings.userId }).from(musicRadioRecordings)
    .where(eq(musicRadioRecordings.id, id)).limit(1)
  if (!row || row.userId !== user.id) return c.json({ error: 'Not found' }, 404)
  if (!stopRecording(id)) return c.json({ error: 'Recording is not active' }, 409)
  return c.json({ ok: true })
})

musicRadioLive.get('/recordings/:id/audio', async (c) => {
  const user = c.get('user')
  const [rec] = await db.select().from(musicRadioRecordings)
    .where(and(eq(musicRadioRecordings.id, c.req.param('id')), eq(musicRadioRecordings.userId, user.id)))
    .limit(1)
  if (!rec?.relPath || rec.status !== 'ready') return c.json({ error: 'Not ready' }, 404)

  let absPath: string
  try { absPath = await resolveUserPath(rec.relPath) } catch { return c.json({ error: 'File missing' }, 404) }
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return c.json({ error: 'File missing' }, 404) }

  // Same clamped-Range handling as podcast episode streaming (seek without re-buffering).
  const rangeHeader = c.req.header('range')
  const rangeMatch = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (rangeMatch) {
    const size = stat.size
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    return new Response(
      createReadStream(absPath, { start, end }) as any,
      {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': 'audio/mpeg',
        },
      }
    )
  }
  return new Response(
    createReadStream(absPath) as any,
    { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' } }
  )
})

musicRadioLive.delete('/recordings/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [rec] = await db.select().from(musicRadioRecordings)
    .where(and(eq(musicRadioRecordings.id, id), eq(musicRadioRecordings.userId, user.id)))
    .limit(1)
  if (!rec) return c.json({ error: 'Not found' }, 404)
  if (isRecordingActive(id)) stopRecording(id)
  await unlinkRecordingFile(rec.relPath)
  await db.delete(musicRadioRecordings).where(eq(musicRadioRecordings.id, id))
  return c.json({ ok: true })
})

/** True when any of the user's recordings are still pending/active (drives UI polling). */
musicRadioLive.get('/recordings-active', async (c) => {
  const user = c.get('user')
  const rows = await db.select({ id: musicRadioRecordings.id }).from(musicRadioRecordings)
    .where(and(eq(musicRadioRecordings.userId, user.id), inArray(musicRadioRecordings.status, ['pending', 'recording'])))
  return c.json({ active: rows.length })
})
