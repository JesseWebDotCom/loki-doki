// Music Studio API — Moises-style stem separation + practice tools.
//
// A "studio track" is a source song (uploaded here) that gets:
//   • analysed (tempo/beats/key/chords) by the audio-analyze job (Essentia)
//   • split into stems by the stem-separate job (Demucs), on demand
// Source + stems live as per-user files under music/studio/<id>/ (see lib/stems/*Job.ts).
// The ML runtime is the `stem-audio` install component; when it's absent the UI shows an
// install prompt and POST /install (admin) enqueues it.

import { Hono } from 'hono'
import { db } from '@/db'
import { musicStudioTracks, users, downloadJobs } from '@/db/schema'
import { eq, and, desc, like } from 'drizzle-orm'
import { requireAuth } from '@/middleware/auth'
import { userPath, resolveUserPath, toRelativePath } from '@/lib/storage/paths'
import { createReadStream, statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { extractEmbeddedCover, fetchBestCover } from '@/lib/stems/cover'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { enqueueAudioAnalyze, enqueueStemSeparation, enqueueStudioSource } from '@/lib/downloadJobs'
import { isStemAudioInstalled, isRoformerGuitarInstalled } from '@/lib/stems/pyenv'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

export const musicStudio = new Hono<AppEnv>()
musicStudio.use('*', requireAuth)

const MAX_BYTES = 60 * 1024 * 1024   // ~60 MB: a long lossless upload
const STEM_MODELS = new Set(['2-stem', '4-stem', '6-stem'])

async function firstName(userId: string): Promise<string> {
  const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId))
  return u?.firstName ?? 'user'
}

/** Transcode any uploaded audio to 44.1k stereo WAV so both Essentia and Demucs decode it
 *  reliably (avoids codec-backend surprises with m4a/aac/opus). Rejects on ffmpeg failure. */
async function transcodeToWav(inputBytes: Uint8Array, outPath: string): Promise<void> {
  const ff = await ensureFfmpeg()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ff, ['-y', '-i', 'pipe:0', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', outPath], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 16_000) err = err.slice(-8_000) })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg transcode exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`)))
    child.stdin?.on('error', () => { /* EPIPE if ffmpeg died early — surfaced by close */ })
    child.stdin?.end(Buffer.from(inputBytes))
  })
}

function trackDto(row: typeof musicStudioTracks.$inferSelect) {
  const stems: string[] = row.stemsJson ? (JSON.parse(row.stemsJson) as string[]) : []
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    durationSec: row.durationSec,
    sourceStatus: row.sourceStatus,
    sourceError: row.sourceError,
    analysisStatus: row.analysisStatus,
    analysisError: row.analysisError,
    bpm: row.bpm,
    keyLabel: row.keyLabel,
    beats: row.beatsJson ? JSON.parse(row.beatsJson) : [],
    chords: row.chordsJson ? JSON.parse(row.chordsJson) : [],
    stemStatus: row.stemStatus,
    stemModel: row.stemModel,
    stemError: row.stemError,
    stems: stems.map((name) => ({ name, url: `/api/music/studio/${row.id}/stem/${name}` })),
    coverUrl: row.coverRelPath ? `/api/music/studio/${row.id}/cover` : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ── Runtime status ─────────────────────────────────────────────────────────────
// Installing the runtime is NOT done here — the `stem-audio` component installs through
// the standard surfaces (setup wizard / Admin → Features) and is boot-repaired when missing.
musicStudio.get('/runtime', (c) => c.json({ installed: isStemAudioInstalled(), guitarEnhanced: isRoformerGuitarInstalled() }))

// ── Upload a source track ───────────────────────────────────────────────────────
// Multipart: `audio` (any audio file) + optional title/artist. Normalizes to WAV, then
// kicks off analysis immediately (fast); stems are a separate on-demand step.
musicStudio.post('/upload', async (c) => {
  const user = c.get('user')
  const form = await c.req.formData()
  const audio = form.get('audio')
  if (!(audio instanceof File)) return c.json({ error: 'audio required' }, 400)
  const bytes = new Uint8Array(await audio.arrayBuffer())
  if (bytes.byteLength === 0) return c.json({ error: 'Empty file' }, 400)
  if (bytes.byteLength > MAX_BYTES) return c.json({ error: 'File too large' }, 413)

  const title = (typeof form.get('title') === 'string' ? String(form.get('title')).trim() : '').slice(0, 160)
    || (audio.name?.replace(/\.[^.]+$/, '') ?? 'Untitled').slice(0, 160)
  const artist = (typeof form.get('artist') === 'string' ? String(form.get('artist')).trim() : '').slice(0, 160) || null

  const id = crypto.randomUUID()
  const fn = await firstName(user.id)
  const abs = await userPath(user.id, fn, 'music', 'studio', id, 'source.wav')
  try {
    await transcodeToWav(bytes, abs)
  } catch (err) {
    logger.warn(`[studio] transcode failed: ${err}`)
    return c.json({ error: 'Could not read that audio file' }, 422)
  }
  const rel = await toRelativePath(abs)

  // Best-effort: pull embedded cover art from the upload's own metadata (ID3/FLAC/MP4). The
  // WAV we transcoded strips art, so extract from the original bytes written to a temp file.
  let coverRel: string | null = null
  const origTmp = join(dirname(abs), 'original.bin')
  const coverPath = join(dirname(abs), 'cover.jpg')
  try {
    await writeFile(origTmp, Buffer.from(bytes))
    if (await extractEmbeddedCover(origTmp, coverPath)) coverRel = await toRelativePath(coverPath)
  } catch { /* no embedded art */ } finally { await rm(origTmp, { force: true }).catch(() => {}) }
  // No embedded art → try the web fallback chain (iTunes / search) from the typed title/artist.
  if (!coverRel && artist) {
    try { if (await fetchBestCover({ artist, title }, coverPath)) coverRel = await toRelativePath(coverPath) } catch { /* none */ }
  }

  const now = new Date()
  await db.insert(musicStudioTracks).values({
    id, userId: user.id, title, artist, sourceRelPath: rel, durationSec: null, coverRelPath: coverRel,
    stemStatus: 'none', stemModel: null, stemsJson: null, stemError: null,
    analysisStatus: 'pending', bpm: null, keyLabel: null, beatsJson: null, chordsJson: null, analysisError: null,
    createdAt: now, updatedAt: now,
  })

  if (isStemAudioInstalled()) await enqueueAudioAnalyze(id, `Analyse ${title}`)
  return c.json({ id })
})

// ── Add a song picked from the Music app ────────────────────────────────────────
// Body: { mbid?, videoId?, title, artist?, durationSec? } from a catalog search result.
// Creates the track immediately (sourceStatus 'fetching') and enqueues a studio-source job
// that resolves + fetches the audio, then analysis. No upload needed.
musicStudio.post('/from-catalog', async (c) => {
  const user = c.get('user')
  type CatalogBody = { mbid?: string; videoId?: string; albumMbid?: string; albumTitle?: string; title?: string; artist?: string; durationSec?: number }
  const body = await c.req.json<CatalogBody>().catch(() => ({} as CatalogBody))
  const title = (body.title ?? '').trim().slice(0, 160)
  if (!title) return c.json({ error: 'title required' }, 400)
  if (!body.mbid && !body.videoId) return c.json({ error: 'mbid or videoId required' }, 400)
  const artist = (body.artist ?? '').trim().slice(0, 160) || null

  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(musicStudioTracks).values({
    id, userId: user.id, title, artist, sourceRelPath: null,
    durationSec: body.durationSec ?? null,
    sourceStatus: 'fetching', sourceError: null,
    stemStatus: 'none', stemModel: null, stemsJson: null, stemError: null,
    analysisStatus: 'none', bpm: null, keyLabel: null, beatsJson: null, chordsJson: null, analysisError: null,
    createdAt: now, updatedAt: now,
  })
  await enqueueStudioSource({
    studioTrackId: id, videoId: body.videoId ?? null, mbid: body.mbid ?? null,
    albumMbid: body.albumMbid ?? null, albumTitle: body.albumTitle ?? null,
    title, artist, durationSec: body.durationSec ?? null,
  }, `Add ${title} to Studio`)
  return c.json({ id })
})

// ── List / get ──────────────────────────────────────────────────────────────────
musicStudio.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(musicStudioTracks)
    .where(eq(musicStudioTracks.userId, user.id))
    .orderBy(desc(musicStudioTracks.createdAt))
  return c.json({ installed: isStemAudioInstalled(), tracks: rows.map(trackDto) })
})

async function ownedTrack(c: any) {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicStudioTracks).where(eq(musicStudioTracks.id, id)).limit(1)
  if (!row) return { err: c.json({ error: 'Not found' }, 404) }
  if (row.userId !== user.id && user.role !== 'admin') return { err: c.json({ error: 'Forbidden' }, 403) }
  return { row }
}

// Live percent for the running job driving a track (from the durable download queue).
// The runners report onProgress({completed: pct, total: 100, note}), persisted to
// download_jobs.progress — so `completed` is already 0-100. Returns null when idle.
async function jobProgress(type: string, vkPrefix: string): Promise<{ pct: number; note?: string } | null> {
  const [j] = await db.select({ progress: downloadJobs.progress, status: downloadJobs.status })
    .from(downloadJobs)
    .where(and(eq(downloadJobs.type, type), like(downloadJobs.variantKey, `${vkPrefix}%`)))
    .orderBy(desc(downloadJobs.updatedAt)).limit(1)
  if (!j || (j.status !== 'running' && j.status !== 'pending')) return null
  if (j.status === 'pending') return { pct: 0, note: 'Queued…' }
  try {
    const p = JSON.parse(j.progress ?? 'null') as { completed?: number; note?: string } | null
    if (p && typeof p.completed === 'number') return { pct: Math.max(0, Math.min(100, Math.round(p.completed))), note: p.note }
  } catch { /* no progress yet */ }
  return { pct: 0 }
}

musicStudio.get('/:id', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const dto = trackDto(row!)
  const stemProgress = (row!.stemStatus === 'separating' || row!.stemStatus === 'pending')
    ? await jobProgress('stem-separate', `stem-separate:${row!.id}:`) : null
  const sourceProgress = row!.sourceStatus === 'fetching'
    ? await jobProgress('studio-source', `studio-source:${row!.id}`) : null
  return c.json({ installed: isStemAudioInstalled(), guitarEnhanced: isRoformerGuitarInstalled(), track: { ...dto, stemProgress, sourceProgress } })
})

// ── Re-run analysis ───────────────────────────────────────────────────────────
musicStudio.post('/:id/analyze', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  if (!isStemAudioInstalled()) return c.json({ error: 'runtime not installed' }, 409)
  await db.update(musicStudioTracks).set({ analysisStatus: 'pending', updatedAt: new Date() }).where(eq(musicStudioTracks.id, row!.id))
  await enqueueAudioAnalyze(row!.id, `Analyse ${row!.title}`)
  return c.json({ ok: true })
})

// ── Generate stems ───────────────────────────────────────────────────────────
const CUSTOM_STEMS = new Set(['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'])
musicStudio.post('/:id/stems', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  if (!isStemAudioInstalled()) return c.json({ error: 'runtime not installed' }, 409)
  const body = await c.req.json<{ model?: string; stems?: string[]; enhancedGuitar?: boolean }>().catch(() => ({} as { model?: string; stems?: string[]; enhancedGuitar?: boolean }))
  const stems = Array.isArray(body.stems) ? body.stems.filter((s) => CUSTOM_STEMS.has(s)) : []
  const enhancedGuitar = body.enhancedGuitar !== false
  const opts = stems.length ? { stems, enhancedGuitar } : { model: STEM_MODELS.has(body.model ?? '') ? body.model! : '4-stem', enhancedGuitar }
  const label = stems.length ? 'custom' : opts.model!
  await db.update(musicStudioTracks).set({ stemStatus: 'pending', stemModel: label, stemError: null, updatedAt: new Date() }).where(eq(musicStudioTracks.id, row!.id))
  await enqueueStemSeparation(row!.id, opts, `Stems: ${row!.title}`)
  return c.json({ ok: true, ...opts })
})

// Range-aware file streamer shared by the source + stem endpoints. Returns a 206 for a
// Range request, a 200 otherwise, or a 404 Response if the file is missing.
function streamFile(c: any, absPath: string, contentType: string): Response {
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return c.json({ error: 'Missing' }, 404) }
  const m = c.req.header('range')?.match(/^bytes=(\d*)-(\d*)$/)
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0
    const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
    if (start >= stat.size || end >= stat.size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    return new Response(createReadStream(absPath, { start, end }) as any, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache',
      },
    })
  }
  return new Response(createReadStream(absPath) as any, {
    headers: { 'Content-Type': contentType, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' },
  })
}

// ── Cover art ───────────────────────────────────────────────────────────────────
musicStudio.get('/:id/cover', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  if (!row!.coverRelPath) return c.json({ error: 'no cover' }, 404)
  let absPath: string
  try { absPath = await resolveUserPath(row!.coverRelPath) } catch { return c.json({ error: 'Missing' }, 404) }
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return c.json({ error: 'Missing' }, 404) }
  return new Response(createReadStream(absPath) as any, {
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(stat.size), 'Cache-Control': 'public, max-age=86400' },
  })
})

// ── Stream the original source mix (range-aware) — lets the user preview a track
// before generating stems. ───────────────────────────────────────────────────────
musicStudio.get('/:id/source', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  if (!row!.sourceRelPath) return c.json({ error: 'no source' }, 404)
  let absPath: string
  try { absPath = await resolveUserPath(row!.sourceRelPath) } catch { return c.json({ error: 'Missing' }, 404) }
  return streamFile(c, absPath, 'audio/wav')
})

// ── Stream a stem (range-aware) ─────────────────────────────────────────────────
musicStudio.get('/:id/stem/:name', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const name = c.req.param('name')
  if (!/^[a-z_]+$/.test(name)) return c.json({ error: 'bad stem' }, 400)
  if (!row!.sourceRelPath) return c.json({ error: 'no source' }, 404)
  let absPath: string
  try { absPath = await resolveUserPath(join(dirname(row!.sourceRelPath), 'stems', `${name}.mp3`)) }
  catch { return c.json({ error: 'Missing' }, 404) }
  return streamFile(c, absPath, 'audio/mpeg')
})

// ── Delete ───────────────────────────────────────────────────────────────────
musicStudio.delete('/:id', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  if (row!.sourceRelPath) {
    try { await rm(dirname(await resolveUserPath(row!.sourceRelPath)), { recursive: true, force: true }) } catch { /* best-effort */ }
  }
  await db.delete(musicStudioTracks).where(eq(musicStudioTracks.id, row!.id))
  return c.json({ ok: true })
})
