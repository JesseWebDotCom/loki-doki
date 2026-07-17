// Track meta for the player chrome: audio facts (codec/bitrate/LUFS), waveform peaks,
// and per-user star ratings — all keyed by unified track ref. Facts come from the
// opportunistic audioScan; a waveform request for an unscanned-but-on-disk ref lazily
// queues a scan so the bar appears on the next play.

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { musicRatings, musicTrackAudio, musicMoments, users } from '@/db/schema'
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
  // waveform shows up on the next play of this track. A miss is 200 {peaks:null}, not
  // 404: "no waveform yet" is an expected answer, and 404s spam the browser console.
  if (!row) queueAudioScan(ref)
  return c.json({ peaks: null })
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

// ── Moments ─────────────────────────────────────────────────────────────────────────
// The household social layer for a track (bookmark + emoji reaction at a timestamp) —
// mirrors video_moments' three-route shape. Household-visible on read; only the author
// can delete their own.
musicMeta.get('/moments/:ref', async (c) => {
  const rows = await db.select({
    id: musicMoments.id, userId: musicMoments.userId, atSec: musicMoments.atSec,
    emoji: musicMoments.emoji, note: musicMoments.note, createdAt: musicMoments.createdAt,
    name: users.nickname, firstName: users.firstName,
  })
    .from(musicMoments)
    .leftJoin(users, eq(users.id, musicMoments.userId))
    .where(eq(musicMoments.ref, c.req.param('ref')))
    .orderBy(asc(musicMoments.atSec))
  return c.json({
    moments: rows.map((r) => ({
      id: r.id, userId: r.userId, atSec: r.atSec, emoji: r.emoji, note: r.note,
      by: r.name || r.firstName || 'Someone',
      mine: r.userId === c.get('user').id,
      createdAt: r.createdAt?.getTime() ?? 0,
    })),
  })
})

musicMeta.post('/moments', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({})) as { ref?: string; atSec?: number; emoji?: string; note?: string }
  if (!body.ref) return c.json({ error: 'ref required' }, 400)
  if (!Number.isFinite(body.atSec)) return c.json({ error: 'atSec required' }, 400)
  const emoji = body.emoji?.trim().slice(0, 8) || null
  const note = body.note?.trim().slice(0, 300) || null
  if (!emoji && !note) return c.json({ error: 'emoji or note required' }, 400)
  const id = randomUUID()
  await db.insert(musicMoments).values({
    id, userId: user.id, ref: body.ref,
    atSec: Math.max(0, Math.floor(body.atSec as number)), emoji, note, createdAt: new Date(),
  })
  return c.json({ id })
})

// Only the author may remove their own reaction.
musicMeta.delete('/moments/:momentId', async (c) => {
  const user = c.get('user')
  await db.delete(musicMoments).where(and(
    eq(musicMoments.id, c.req.param('momentId')),
    eq(musicMoments.userId, user.id),
  ))
  return c.json({ ok: true })
})
