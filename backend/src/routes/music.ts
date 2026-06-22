// Music app — per-user track storage + serving.
//
// v1 generation happens entirely client-side (the offline MIDI engine renders a
// WAV in the browser, see frontend/src/lib/music/engine.ts); this route only
// stores the finished blob and serves it back. The schema + routes are shaped so
// future server-side engines (neural/Suno-like) and stem separation slot in
// additively: a `POST /tracks/generate` (genQueue + SSE, writing into the same row
// via the `state` lifecycle) and `POST /tracks/:id/stems` (child kind='stem' rows
// under parentTrackId) would not require changing anything here.

import { Hono } from 'hono'
import { db } from '@/db'
import { musicTracks, users } from '@/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { requireAuth } from '@/middleware/auth'
import { resolveUserPath, userPath, toRelativePath } from '@/lib/storage/paths'
import { createReadStream, statSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppEnv } from '@/types'

export const music = new Hono<AppEnv>()
music.use('*', requireAuth)

const MAX_BYTES = 25 * 1024 * 1024  // generous for full-length beds at 24k mono WAV
const KINDS = ['track', 'intro', 'outro', 'loop', 'bed'] as const
type Kind = (typeof KINDS)[number]

function clampStr(v: FormDataEntryValue | null, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s.slice(0, max) : null
}
function numOrNull(v: FormDataEntryValue | null): number | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Create ────────────────────────────────────────────────────────────────────
// Multipart: `audio` (WAV blob) + metadata fields. Stores the file in a per-track
// directory (music/<id>/main.wav) so future stems can live alongside.
music.post('/tracks', async (c) => {
  const user = c.get('user')
  const form = await c.req.formData()

  const audio = form.get('audio')
  if (!(audio instanceof File)) return c.json({ error: 'audio required' }, 400)
  const bytes = new Uint8Array(await audio.arrayBuffer())
  if (bytes.byteLength === 0) return c.json({ error: 'Empty body' }, 400)
  if (bytes.byteLength > MAX_BYTES) return c.json({ error: 'Too large' }, 413)

  const title = clampStr(form.get('title'), 120) ?? 'Untitled track'
  const kindRaw = clampStr(form.get('kind'), 16)
  const kind: Kind = (KINDS as readonly string[]).includes(kindRaw ?? '') ? (kindRaw as Kind) : 'track'
  const engine = clampStr(form.get('engine'), 32) ?? 'midi-offline'

  const id = crypto.randomUUID()
  const [userRow] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, user.id))
  const abs = await userPath(user.id, userRow?.firstName ?? 'user', 'music', id, 'main.wav')
  await writeFile(abs, bytes)
  const rel = await toRelativePath(abs)

  const now = new Date()
  await db.insert(musicTracks).values({
    id,
    userId: user.id,
    title,
    kind,
    engine,
    styleId: clampStr(form.get('styleId'), 64),
    bpm: numOrNull(form.get('bpm')),
    keyName: clampStr(form.get('keyName'), 16),
    sourceName: clampStr(form.get('sourceName'), 200),
    prompt: clampStr(form.get('prompt'), 2000),
    metaJson: clampStr(form.get('metaJson'), 8000),
    durationSec: numOrNull(form.get('durationSec')),
    state: 'ready',
    path: rel,
    createdAt: now,
    updatedAt: now,
  })

  return c.json({ id })
})

// ── List ────────────────────────────────────────────────────────────────────
// The current user's tracks, newest first. Stems (kind='stem') are excluded from
// the main listing — they belong nested under their parent track.
music.get('/tracks', async (c) => {
  const user = c.get('user')
  const kindFilter = c.req.query('kind')
  const engineFilter = c.req.query('engine')

  const rows = await db.select({
    id: musicTracks.id,
    title: musicTracks.title,
    kind: musicTracks.kind,
    engine: musicTracks.engine,
    styleId: musicTracks.styleId,
    bpm: musicTracks.bpm,
    keyName: musicTracks.keyName,
    sourceName: musicTracks.sourceName,
    durationSec: musicTracks.durationSec,
    state: musicTracks.state,
    createdAt: musicTracks.createdAt,
  })
    .from(musicTracks)
    .where(eq(musicTracks.userId, user.id))
    .orderBy(desc(musicTracks.createdAt))

  const tracks = rows.filter((t) => {
    if (t.kind === 'stem') return false
    if (kindFilter && t.kind !== kindFilter) return false
    if (engineFilter && t.engine !== engineFilter) return false
    return true
  })
  return c.json({ tracks })
})

// ── Serve audio (range-aware, so the Library player can seek) ─────────────────
music.get('/tracks/:id/audio', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [row] = await db.select({ path: musicTracks.path, userId: musicTracks.userId })
    .from(musicTracks).where(eq(musicTracks.id, id))
  if (!row?.path) return c.json({ error: 'Not found' }, 404)
  if (row.userId !== user.id && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  let absPath: string
  try { absPath = await resolveUserPath(row.path) } catch { return c.json({ error: 'Missing' }, 404) }
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return c.json({ error: 'Missing' }, 404) }

  const range = c.req.header('range')
  const m = range?.match(/^bytes=(\d*)-(\d*)$/)
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0
    const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
    if (start >= stat.size || end >= stat.size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    return new Response(createReadStream(absPath, { start, end }) as any, {
      status: 206,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    })
  }

  return new Response(createReadStream(absPath) as any, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    },
  })
})

// ── Rename ────────────────────────────────────────────────────────────────────
music.patch('/tracks/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }))
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : ''
  if (!title) return c.json({ error: 'title required' }, 400)

  const [row] = await db.select({ userId: musicTracks.userId }).from(musicTracks).where(eq(musicTracks.id, id))
  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.userId !== user.id && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  await db.update(musicTracks).set({ title, updatedAt: new Date() }).where(eq(musicTracks.id, id))
  return c.json({ ok: true })
})

// ── Delete ────────────────────────────────────────────────────────────────────
// Removes the DB row and the per-track directory (main.wav + any future stems).
music.delete('/tracks/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [row] = await db.select({ path: musicTracks.path, userId: musicTracks.userId })
    .from(musicTracks).where(eq(musicTracks.id, id))
  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.userId !== user.id && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  if (row.path) {
    try {
      const abs = await resolveUserPath(row.path)
      await rm(dirname(abs), { recursive: true, force: true })
    } catch { /* file cleanup is best-effort */ }
  }
  await db.delete(musicTracks).where(and(eq(musicTracks.id, id), eq(musicTracks.userId, row.userId)))
  return c.json({ ok: true })
})
