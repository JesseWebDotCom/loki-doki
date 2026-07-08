// Track meta for the player chrome: audio facts (codec/bitrate/LUFS), waveform peaks,
// and per-user star ratings — all keyed by unified track ref. Facts come from the
// opportunistic audioScan; a waveform request for an unscanned-but-on-disk ref lazily
// queues a scan so the bar appears on the next play.

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { musicRatings, musicTrackAudio } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { queueAudioScan } from '@/lib/music/audioScan'
import { resolveStreamMeta } from '@/lib/music/trackRef'
import type { AppEnv } from '@/types'

export const musicMeta = new Hono<AppEnv>()
musicMeta.use('*', requireAuth)

// ── Audio facts (batched) ───────────────────────────────────────────────────────────
musicMeta.get('/audio', async (c) => {
  const refs = (c.req.query('refs') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50)
  if (!refs.length) return c.json({})
  const rows = await db.select({
    ref: musicTrackAudio.ref, lufs: musicTrackAudio.lufs, truePeakDb: musicTrackAudio.truePeakDb,
    codec: musicTrackAudio.codec, bitrateKbps: musicTrackAudio.bitrateKbps,
    sampleRate: musicTrackAudio.sampleRate, channels: musicTrackAudio.channels,
    durationSec: musicTrackAudio.durationSec,
  }).from(musicTrackAudio).where(inArray(musicTrackAudio.ref, refs))
  const out: Record<string, unknown> = {}
  for (const r of rows) out[r.ref] = r
  // Refs without a scanned row: the owning source may still know codec facts (plex/local
  // indexes carry them) — fill those in so the badge works without a scan.
  for (const ref of refs) {
    if (out[ref]) continue
    const meta = await resolveStreamMeta(ref)
    if (meta) out[ref] = { ref, lufs: null, truePeakDb: null, durationSec: null, channels: null, ...meta }
  }
  return c.json(out)
})

// ── Waveform peaks ──────────────────────────────────────────────────────────────────
musicMeta.get('/waveform/:ref', async (c) => {
  const ref = c.req.param('ref')
  const [row] = await db.select({ peaks: musicTrackAudio.peaks }).from(musicTrackAudio)
    .where(eq(musicTrackAudio.ref, ref)).limit(1)
  if (row?.peaks?.length) {
    return c.json({ peaks: Array.from(new Uint8Array(row.peaks)) })
  }
  // Not scanned (or scanned without peaks): lazily queue — if the audio is on disk the
  // waveform shows up on the next play of this track.
  if (!row) queueAudioScan(ref)
  return c.json({ error: 'not scanned' }, 404)
})

// ── Star ratings ────────────────────────────────────────────────────────────────────
musicMeta.get('/ratings', async (c) => {
  const user = c.get('user')
  const refs = (c.req.query('refs') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100)
  const rows = refs.length
    ? await db.select({ ref: musicRatings.ref, stars: musicRatings.stars }).from(musicRatings)
        .where(and(eq(musicRatings.userId, user.id), inArray(musicRatings.ref, refs)))
    : []
  const out: Record<string, number> = {}
  for (const r of rows) out[r.ref] = r.stars
  return c.json(out)
})

musicMeta.put('/ratings', async (c) => {
  const user = c.get('user')
  const { ref, stars, title, artist } = await c.req.json<{ ref: string; stars: number; title?: string; artist?: string }>()
  if (!ref || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    return c.json({ error: 'ref and stars (1-5) required' }, 400)
  }
  const now = new Date()
  await db.insert(musicRatings)
    .values({ id: randomUUID(), userId: user.id, ref, stars, title: title ?? null, artist: artist ?? null, updatedAt: now })
    .onConflictDoUpdate({
      target: [musicRatings.userId, musicRatings.ref],
      set: { stars, title: title ?? null, artist: artist ?? null, updatedAt: now },
    })
  return c.json({ ok: true })
})

musicMeta.delete('/ratings/:ref', async (c) => {
  const user = c.get('user')
  await db.delete(musicRatings)
    .where(and(eq(musicRatings.userId, user.id), eq(musicRatings.ref, c.req.param('ref'))))
  return c.json({ ok: true })
})
