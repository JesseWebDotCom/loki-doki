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
import { musicStudioTracks, musicStudioTutorials, musicStudioTabs, users, downloadJobs } from '@/db/schema'
import { eq, and, ne, desc, like, inArray, sql } from 'drizzle-orm'
import { requireAuth } from '@/middleware/auth'
import { userPath, resolveUserPath, toRelativePath } from '@/lib/storage/paths'
import { createReadStream, statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { extractEmbeddedCover, fetchBestCover } from '@/lib/stems/cover'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { enqueueAudioAnalyze, enqueueStemSeparation, enqueueStudioSource, enqueueLyricAlign } from '@/lib/downloadJobs'
import { isStemAudioInstalled, isRoformerGuitarInstalled } from '@/lib/stems/pyenv'
import type { AlignedLine } from '@/lib/stems/reconcileLyrics'
import { webSearch } from '@/lib/webSearch'
import { searchGProTab, downloadGProTabFile, isGProTabSongUrl } from '@/lib/music/gprotab'
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
    // Lyrics re-timed to this track's own vocals (forced alignment). When ready, the client
    // uses these instead of raw LRCLIB timing. `lyrics` is [{sec, text}] or [] when not ready.
    lyricsAlignStatus: row.lyricsAlignStatus,
    lyrics: row.lyricsJson ? (JSON.parse(row.lyricsJson) as AlignedLine[]) : [],
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
    // Only claim 'pending' if we're actually enqueuing the analyze job. When the stem runtime
    // isn't installed nothing ever runs it (and only lyric-align self-heals on GET), so 'pending'
    // showed an analysis spinner forever. 'none' matches lib/stems/fetchSource.ts's absent state.
    analysisStatus: isStemAudioInstalled() ? 'pending' : 'none', bpm: null, keyLabel: null, beatsJson: null, chordsJson: null, analysisError: null,
    createdAt: now, updatedAt: now,
  })

  if (isStemAudioInstalled()) await enqueueAudioAnalyze(id, `Analyse ${title}`)
  return c.json({ id })
})

// ── Karaoke suggestions (popular sing-along standards) ───────────────────────────
// A curated set of karaoke anthems — the songs everyone knows the words to, which is a far
// better "popular karaoke" list than a current-hits chart. Enriched with Deezer cover art
// and cached in-process for a day (the list is static).
const KARAOKE_PICKS: { title: string; artist: string }[] = [
  { title: "Don't Stop Believin'", artist: 'Journey' },
  { title: 'Bohemian Rhapsody', artist: 'Queen' },
  { title: 'Sweet Caroline', artist: 'Neil Diamond' },
  { title: "Livin' On A Prayer", artist: 'Bon Jovi' },
  { title: 'I Wanna Dance with Somebody', artist: 'Whitney Houston' },
  { title: 'Mr. Brightside', artist: 'The Killers' },
  { title: 'Wonderwall', artist: 'Oasis' },
  { title: 'Africa', artist: 'Toto' },
  { title: 'Dancing Queen', artist: 'ABBA' },
  { title: 'Total Eclipse of the Heart', artist: 'Bonnie Tyler' },
  { title: 'Take On Me', artist: 'a-ha' },
  { title: "Sweet Child O' Mine", artist: "Guns N' Roses" },
  { title: 'I Will Survive', artist: 'Gloria Gaynor' },
  { title: 'Shallow', artist: 'Lady Gaga' },
  { title: 'Piano Man', artist: 'Billy Joel' },
  { title: 'Killing Me Softly With His Song', artist: 'Fugees' },
]
let karaokeSuggestCache: { at: number; items: Array<{ title: string; artist: string; cover: string | null }> } | null = null
musicStudio.get('/karaoke/suggestions', async (c) => {
  if (karaokeSuggestCache && Date.now() - karaokeSuggestCache.at < 24 * 3600_000) {
    return c.json({ suggestions: karaokeSuggestCache.items })
  }
  const { deezerTrackCover } = await import('@/lib/music/deezer')
  const items = await Promise.all(KARAOKE_PICKS.map(async (p) => ({
    title: p.title, artist: p.artist,
    cover: await deezerTrackCover(p.artist, p.title).catch(() => null),
  })))
  karaokeSuggestCache = { at: Date.now(), items }
  return c.json({ suggestions: items })
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

// ── Karaoke prepare (find-or-create a 2-stem instrumental+vocals pair) ────────────
// The karaoke page calls this for each queued song. It reuses an existing stem-separated
// track for the same videoId (dedup — a full Demucs run is minutes) instead of making a new
// one every time, and kicks the source-fetch + 2-stem separation when there isn't one yet.
// Returns a track id the client then polls via GET /:id and plays via GET /:id/stem/:name.

// Concurrent prepares for the SAME song (a double-fired client effect, current+next prefetch
// of a duplicated queue entry, two tabs) both miss the find below and each kick a full
// download + Demucs run. Serialize per user+song so the second caller awaits the first.
const inflightKaraokePrepare = new Map<string, Promise<{ id: string; reused: boolean }>>()

musicStudio.post('/karaoke/prepare', async (c) => {
  const user = c.get('user')
  if (!isStemAudioInstalled()) return c.json({ error: 'The stem-audio runtime is not installed yet.' }, 409)
  type Body = { videoId?: string; title?: string; artist?: string; durationSec?: number }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const videoId = (body.videoId ?? '').trim()
  const title = (body.title ?? '').trim().slice(0, 160)
  if (!videoId || !title) return c.json({ error: 'videoId and title required' }, 400)
  const artist = (body.artist ?? '').trim().slice(0, 160) || null

  const flightKey = `${user.id}|${title.toLowerCase()}|${(artist ?? '').toLowerCase()}`
  const inflight = inflightKaraokePrepare.get(flightKey)
  if (inflight) return c.json(await inflight)

  const work = (async (): Promise<{ id: string; reused: boolean }> => {
    // Reuse a cached karaoke separation for the SAME song (dedup by title+artist, not the resolved
    // ref - a song can resolve to a Plex ref one time and a YouTube id the next, so keying on the
    // ref missed the cache). Skip failed rows; touch last_used_at so the TTL sweep keeps it alive.
    const now = new Date()
    const [existing] = await db.select().from(musicStudioTracks)
      .where(and(
        eq(musicStudioTracks.userId, user.id),
        eq(musicStudioTracks.origin, 'karaoke'),
        ne(musicStudioTracks.sourceStatus, 'failed'),
        sql`lower(${musicStudioTracks.title}) = ${title.toLowerCase()}`,
        sql`lower(coalesce(${musicStudioTracks.artist}, '')) = ${(artist ?? '').toLowerCase()}`,
      ))
      .orderBy(desc(musicStudioTracks.createdAt)).limit(1)
    if (existing) {
      await db.update(musicStudioTracks).set({ lastUsedAt: now, updatedAt: now }).where(eq(musicStudioTracks.id, existing.id))
      if (existing.sourceStatus === 'ready' && (existing.stemStatus === 'none' || existing.stemStatus === 'failed')) {
        await db.update(musicStudioTracks).set({ stemStatus: 'pending', stemError: null }).where(eq(musicStudioTracks.id, existing.id))
        await enqueueStemSeparation(existing.id, { model: '2-stem' }, `Karaoke stems: ${existing.title}`)
      }
      return { id: existing.id, reused: true }
    }

    const id = crypto.randomUUID()
    await db.insert(musicStudioTracks).values({
      id, userId: user.id, title, artist, sourceRelPath: null, sourceVideoId: videoId, origin: 'karaoke', lastUsedAt: now,
      durationSec: body.durationSec ?? null,
      sourceStatus: 'fetching', sourceError: null,
      stemStatus: 'none', stemModel: null, stemsJson: null, stemError: null,
      analysisStatus: 'none', bpm: null, keyLabel: null, beatsJson: null, chordsJson: null, analysisError: null,
      createdAt: now, updatedAt: now,
    })
    // Fetch the source, then (chained by the client's poll → it will already be 'pending')
    // separate. We pre-arm stems to 'pending' so the client shows "preparing" immediately;
    // the separation is enqueued by the source job's completion via the karaoke auto-chain below.
    await enqueueStudioSource({
      studioTrackId: id, videoId, mbid: null, albumMbid: null, albumTitle: null,
      title, artist, durationSec: body.durationSec ?? null, thenSeparate: '2-stem',
    }, `Karaoke: ${title}`)
    return { id, reused: false }
  })()

  inflightKaraokePrepare.set(flightKey, work)
  try {
    return c.json(await work)
  } finally {
    inflightKaraokePrepare.delete(flightKey)
  }
})

// ── Karaoke library (already-prepared songs) ──────────────────────────────────────
// Songs whose stems are already on disk survive restarts/refreshes — surface them so
// re-singing is one tap and never re-downloads or re-separates. Deduped by song (the
// pre-serialization race could leave duplicate rows), most recently sung first.
musicStudio.get('/karaoke/ready', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(musicStudioTracks)
    .where(and(
      eq(musicStudioTracks.userId, user.id),
      eq(musicStudioTracks.origin, 'karaoke'),
      eq(musicStudioTracks.stemStatus, 'ready'),
    ))
    .orderBy(desc(musicStudioTracks.lastUsedAt), desc(musicStudioTracks.createdAt))
    .limit(48)
  const seen = new Set<string>()
  const songs = rows.filter((r) => {
    const k = `${r.title.toLowerCase()}|${(r.artist ?? '').toLowerCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, 24).map((r) => ({
    id: r.id,
    title: r.title,
    artist: r.artist,
    videoId: r.sourceVideoId,
    durationSec: r.durationSec,
    coverUrl: r.coverRelPath ? `/api/music/studio/${r.id}/cover` : null,
  }))
  return c.json({ songs })
})

// ── List / get ──────────────────────────────────────────────────────────────────
musicStudio.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(musicStudioTracks)
    .where(and(eq(musicStudioTracks.userId, user.id), eq(musicStudioTracks.origin, 'studio')))
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

  // Retro-fit + self-heal: kick off alignment when a track with a vocals stem has never been
  // aligned ('none'), OR is stuck 'pending'/'aligning' with no live job (its job died — e.g. a
  // crash or a code reload mid-run). We do NOT auto-retry a terminal 'failed'/'ready' (those were
  // genuinely attempted; the user can re-run via POST /:id/align). Keeps ALL separated tracks
  // converging to corrected timing without ever looping on a truly-unfixable song.
  if (row!.stemStatus === 'ready' && isStemAudioInstalled()) {
    const stems: string[] = row!.stemsJson ? (JSON.parse(row!.stemsJson) as string[]) : []
    if (stems.includes('vocals')) {
      const st = row!.lyricsAlignStatus
      let shouldAlign = st === 'none'
      if (!shouldAlign && (st === 'pending' || st === 'aligning')) {
        const [live] = await db.select({ id: downloadJobs.id }).from(downloadJobs)
          .where(and(eq(downloadJobs.type, 'lyric-align'), like(downloadJobs.variantKey, `lyric-align:${row!.id}%`),
            inArray(downloadJobs.status, ['pending', 'running']))).limit(1)
        shouldAlign = !live   // status says busy but no job is actually queued/running → died
      }
      if (shouldAlign) {
        await db.update(musicStudioTracks).set({ lyricsAlignStatus: 'pending', lyricsAlignError: null, updatedAt: new Date() }).where(eq(musicStudioTracks.id, row!.id))
        await enqueueLyricAlign(row!.id, `Align lyrics: ${row!.title}`)
        row!.lyricsAlignStatus = 'pending'
      }
    }
  }

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

// ── Align lyrics ───────────────────────────────────────────────────────────────
// Re-time LRCLIB lyrics to this track's vocals stem. Normally auto-runs after separation;
// this endpoint re-runs it (e.g. for tracks separated before the feature existed, or a retry).
musicStudio.post('/:id/align', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  if (!isStemAudioInstalled()) return c.json({ error: 'runtime not installed' }, 409)
  const stems: string[] = row!.stemsJson ? (JSON.parse(row!.stemsJson) as string[]) : []
  if (row!.stemStatus !== 'ready' || !stems.includes('vocals')) return c.json({ error: 'needs a vocals stem first' }, 409)
  await db.update(musicStudioTracks).set({ lyricsAlignStatus: 'pending', lyricsAlignError: null, updatedAt: new Date() }).where(eq(musicStudioTracks.id, row!.id))
  await enqueueLyricAlign(row!.id, `Align lyrics: ${row!.title}`)
  return c.json({ ok: true })
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

// ── Tutorials (pinned YouTube guitar lessons for this track) ─────────────────────
// Suggestions/search/"find more" all go through the existing /api/youtube/search endpoint on
// the client — this is just the pin/unpin CRUD, ordered by pin time.
musicStudio.get('/:id/tutorials', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const rows = await db.select().from(musicStudioTutorials)
    .where(eq(musicStudioTutorials.trackId, row!.id))
    .orderBy(desc(musicStudioTutorials.createdAt))
  return c.json({ tutorials: rows })
})

musicStudio.post('/:id/tutorials', async (c) => {
  const user = c.get('user')
  const { row, err } = await ownedTrack(c)
  if (err) return err
  type Body = { videoId?: string; title?: string; author?: string; thumbnailUrl?: string; durationSec?: number }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const videoId = (body.videoId ?? '').trim()
  const title = (body.title ?? '').trim().slice(0, 300)
  if (!videoId || !title) return c.json({ error: 'videoId and title required' }, 400)
  const [existing] = await db.select().from(musicStudioTutorials)
    .where(and(eq(musicStudioTutorials.trackId, row!.id), eq(musicStudioTutorials.videoId, videoId))).limit(1)
  if (existing) return c.json({ tutorial: existing })
  const tutorial = {
    id: crypto.randomUUID(), trackId: row!.id, userId: user.id, videoId, title,
    author: body.author?.trim() || null, thumbnailUrl: body.thumbnailUrl || null,
    durationSec: body.durationSec ?? null, createdAt: new Date(),
  }
  await db.insert(musicStudioTutorials).values(tutorial)
  return c.json({ tutorial })
})

musicStudio.delete('/:id/tutorials/:videoId', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  await db.delete(musicStudioTutorials)
    .where(and(eq(musicStudioTutorials.trackId, row!.id), eq(musicStudioTutorials.videoId, c.req.param('videoId'))))
  return c.json({ ok: true })
})

// ── Tabs (imported Guitar Pro / MusicXML, rendered + synced client-side via alphaTab) ────
const TAB_EXTENSIONS = new Set(['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'musicxml', 'xml'])
const TAB_MAX_BYTES = 20 * 1024 * 1024   // tab files are small; generous ceiling against abuse

function tabDto(row: typeof musicStudioTabs.$inferSelect) {
  let align: { startSec: number; endSec: number } | null = null
  try { align = row.alignJson ? JSON.parse(row.alignJson) : null } catch { align = null }
  return {
    id: row.id, title: row.title, instrument: row.instrument, status: row.status, tabError: row.tabError,
    align, fileUrl: `/api/music/studio/${row.trackId}/tabs/${row.id}/file`,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
}

async function ownedTab(c: any, trackRow: typeof musicStudioTracks.$inferSelect) {
  const [row] = await db.select().from(musicStudioTabs)
    .where(and(eq(musicStudioTabs.id, c.req.param('tabId')), eq(musicStudioTabs.trackId, trackRow.id))).limit(1)
  if (!row) return { err: c.json({ error: 'Not found' }, 404) }
  return { row }
}

/** Persist tab-file bytes + row — shared by the direct upload and the GProTab import. */
async function saveTabFile(userId: string, trackId: string, bytes: Uint8Array, ext: string, title: string, instrument: string | null) {
  const id = crypto.randomUUID()
  const fn = await firstName(userId)
  const abs = await userPath(userId, fn, 'music', 'studio', trackId, 'tabs', `${id}.${ext}`)
  await writeFile(abs, Buffer.from(bytes))
  const rel = await toRelativePath(abs)

  const now = new Date()
  await db.insert(musicStudioTabs).values({
    id, trackId, userId, title, instrument, sourceRelPath: rel,
    status: 'ready', tabError: null, alignJson: null, createdAt: now, updatedAt: now,
  })
  const [saved] = await db.select().from(musicStudioTabs).where(eq(musicStudioTabs.id, id))
  return saved!
}

musicStudio.post('/:id/tabs', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const user = c.get('user')
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400)
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  if (!TAB_EXTENSIONS.has(ext)) return c.json({ error: 'Unsupported file type — use Guitar Pro (.gp/.gpx) or MusicXML' }, 400)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength === 0) return c.json({ error: 'Empty file' }, 400)
  if (bytes.byteLength > TAB_MAX_BYTES) return c.json({ error: 'File too large' }, 413)

  const title = (typeof form.get('title') === 'string' ? String(form.get('title')).trim() : '').slice(0, 160)
    || file.name.replace(/\.[^.]+$/, '').slice(0, 160)
  const instrument = (typeof form.get('instrument') === 'string' ? String(form.get('instrument')).trim() : '').slice(0, 60) || null

  const saved = await saveTabFile(user.id, row!.id, bytes, ext, title, instrument)
  return c.json({ tab: tabDto(saved) })
})

// ── Import a tab file straight from a GProTab.net song page ─────────────────────────
// The server does the download (browser CORS won't allow it), validates it like an upload,
// and stores it through the same pipeline. `url` is strictly allowlisted to gprotab.net song
// pages (checked again inside downloadGProTabFile) — this is NOT a general fetch-any-URL
// endpoint, so no broader SSRF surface opens up.
musicStudio.post('/:id/tabs/from-url', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const user = c.get('user')
  const body = await c.req.json<{ url?: string; title?: string }>().catch(() => ({} as { url?: string; title?: string }))
  const url = (body.url ?? '').trim()
  if (!isGProTabSongUrl(url)) return c.json({ error: 'Only gprotab.net tab pages can be imported' }, 400)

  const file = await downloadGProTabFile(url, TAB_MAX_BYTES)
  if (!file) return c.json({ error: 'Could not download that tab file' }, 502)
  const ext = (file.filename.split('.').pop() ?? '').toLowerCase()
  if (!TAB_EXTENSIONS.has(ext)) return c.json({ error: `Unsupported file type: .${ext}` }, 422)

  const title = (body.title ?? '').trim().slice(0, 160)
    || file.filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').slice(0, 160)
  const saved = await saveTabFile(user.id, row!.id, file.bytes, ext, title, null)
  return c.json({ tab: tabDto(saved) })
})

musicStudio.get('/:id/tabs', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const rows = await db.select().from(musicStudioTabs)
    .where(eq(musicStudioTabs.trackId, row!.id)).orderBy(desc(musicStudioTabs.createdAt))
  return c.json({ tabs: rows.map(tabDto) })
})

musicStudio.get('/:id/tabs/:tabId/file', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const { row: tab, err: tabErr } = await ownedTab(c, row!)
  if (tabErr) return tabErr
  let absPath: string
  try { absPath = await resolveUserPath(tab!.sourceRelPath) } catch { return c.json({ error: 'Missing' }, 404) }
  return streamFile(c, absPath, 'application/octet-stream')
})

musicStudio.put('/:id/tabs/:tabId/align', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const { row: tab, err: tabErr } = await ownedTab(c, row!)
  if (tabErr) return tabErr
  const body = await c.req.json<{ startSec?: number; endSec?: number }>().catch(() => ({} as { startSec?: number; endSec?: number }))
  if (typeof body.startSec !== 'number' || typeof body.endSec !== 'number' || !(body.endSec > body.startSec)) {
    return c.json({ error: 'startSec and endSec (endSec > startSec) required' }, 400)
  }
  await db.update(musicStudioTabs)
    .set({ alignJson: JSON.stringify({ startSec: body.startSec, endSec: body.endSec }), updatedAt: new Date() })
    .where(eq(musicStudioTabs.id, tab!.id))
  return c.json({ ok: true })
})

musicStudio.delete('/:id/tabs/:tabId', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const { row: tab, err: tabErr } = await ownedTab(c, row!)
  if (tabErr) return tabErr
  try { await rm(await resolveUserPath(tab!.sourceRelPath), { force: true }) } catch { /* best-effort */ }
  await db.delete(musicStudioTabs).where(eq(musicStudioTabs.id, tab!.id))
  return c.json({ ok: true })
})

// ── Find a tab online (Ultimate Guitar / Songsterr) ───────────────────────────────
// Site-scoped web search — no scraping of those sites themselves, just links to view on the
// original site (they don't allow framing anyway). Reuses the app's own multi-engine
// `webSearch()` (SearXNG-backed with keyless fallback) rather than a bespoke scraper; the
// site: + exclusion-term query shape mirrors what's already proven to find the right page.
// Ultimate Guitar serves the same tab catalog under dozens of per-language subdomains
// (ja., it., de., ru., ...); those pages are real tabs but not the canonical English one most
// users expect, and a site:-scoped search happily returns them since they're still on
// ultimate-guitar.com. Restrict to the apex/www host explicitly.
function isCanonicalHost(url: string, host: string): boolean {
  try { const h = new URL(url).hostname; return h === host || h === `www.${host}` } catch { return false }
}

musicStudio.get('/:id/tab-search', async (c) => {
  const { row, err } = await ownedTrack(c)
  if (err) return err
  const q = (c.req.query('q') ?? `${row!.artist ?? ''} ${row!.title}`).trim().slice(0, 200)
  if (!q) return c.json({ ultimateGuitar: [], songsterr: [], gprotab: [] })
  const [ultimateGuitar, songsterr, gprotab] = await Promise.all([
    webSearch(`site:ultimate-guitar.com "${q}" tab official -bass -chords`, 8)
      .then((rs) => rs.filter((r) => isCanonicalHost(r.url, 'ultimate-guitar.com')).slice(0, 5)),
    webSearch(`site:songsterr.com "${q}" tab -bass -chords`, 8)
      .then((rs) => rs.filter((r) => isCanonicalHost(r.url, 'songsterr.com')).slice(0, 5)),
    // GProTab has its own on-site search (its pages barely surface in web-search indexes) and,
    // unlike the two above, its results are actual downloadable files → the Import flow.
    // Its search is AND-strict — "artist + title" together often returns nothing while the
    // title alone hits — so fall back to title-only and rank the matching artist first.
    searchGProTab(q, 5).then(async (rs) => {
      const title = row!.title.trim()
      if (rs.length > 0 || !title || title.toLowerCase() === q.toLowerCase()) return rs
      const artist = (row!.artist ?? '').toLowerCase()
      const retried = await searchGProTab(title, 8)
      if (!artist) return retried.slice(0, 5)
      return retried
        .sort((a, b) => Number(b.artist.toLowerCase().includes(artist)) - Number(a.artist.toLowerCase().includes(artist)))
        .slice(0, 5)
    }),
  ])
  return c.json({ ultimateGuitar, songsterr, gprotab })
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
