// lyric-align job runner: re-time LRCLIB lyric lines to a Studio track's OWN vocals stem via
// forced alignment (align.py, torchaudio MMS_FA), so the karaoke highlight matches what's
// actually sung — LRCLIB's timestamps are for whatever recording it matched, often a different
// edit/re-record. Runs in the compute lane (domain 'stem-audio'), auto-triggered after stems.
//
// Best-effort: needs a vocals stem AND plain lyrics from LRCLIB. If either is missing, or the
// aligner can't lock on, the row is marked failed and the UI falls back to raw LRCLIB timing.

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicStudioTracks } from '@/db/schema'
import { resolveUserPath } from '@/lib/storage/paths'
import { stemVenvPython, ALIGN_SCRIPT, TORCH_HOME, isStemAudioInstalled, ensureLyricAlignModel } from './pyenv'
import { plainLyricsForAlign, syncedLyricsForAlign } from '@/routes/musicInfo'
import { reconcile, type AlignedLine } from './reconcileLyrics'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

export interface LyricAlignJobPayload { studioTrackId: string }

interface AlignManifest { lines: AlignedLine[]; alignedWords?: number; totalWords?: number }

/** Run align.py against a vocals stem + lyrics text file; parse JSON. Rejects on non-zero exit. */
function runAlign(python: string, audio: string, textFile: string, signal?: AbortSignal): Promise<AlignManifest> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [ALIGN_SCRIPT, audio, textFile], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, TORCH_HOME },   // MMS_FA model cache lives under data/torch
    })
    let out = '', err = ''
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 16_000) err = err.slice(-8_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      if (code !== 0) return reject(new Error(`align.py exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))
      try { resolve(JSON.parse(out) as AlignManifest) }
      catch (e) { reject(new Error(`align.py produced invalid JSON: ${e}`)) }
    })
  })
}

export async function runAlignJob(
  payload: LyricAlignJobPayload,
  signal?: AbortSignal,
  onProgress?: (p: DownloadProgress & { note?: string }) => void,
): Promise<void> {
  const { studioTrackId } = payload
  const [row] = await db.select().from(musicStudioTracks).where(eq(musicStudioTracks.id, studioTrackId)).limit(1)
  if (!row) { logger.info(`[align] studio track ${studioTrackId} gone — skipping`); return }
  if (!isStemAudioInstalled()) throw new Error('stem-audio runtime not installed')

  // Need the isolated vocals stem — mixed audio aligns far worse, so require separation first.
  const stems: string[] = row.stemsJson ? (JSON.parse(row.stemsJson) as string[]) : []
  if (row.stemStatus !== 'ready' || !stems.includes('vocals')) {
    logger.info(`[align] ${studioTrackId}: no vocals stem — skipping`)
    await db.update(musicStudioTracks).set({ lyricsAlignStatus: 'none', updatedAt: new Date() }).where(eq(musicStudioTracks.id, studioTrackId))
    return
  }
  if (!row.sourceRelPath) { logger.info(`[align] ${studioTrackId}: no source path — skipping`); return }

  await db.update(musicStudioTracks)
    .set({ lyricsAlignStatus: 'aligning', lyricsAlignError: null, updatedAt: new Date() })
    .where(eq(musicStudioTracks.id, studioTrackId))
  onProgress?.({ completed: 5, total: 100, speedBps: 0, etaSeconds: 0, note: 'Fetching lyrics…' })

  let tmp: string | null = null
  try {
    const lyrics = await plainLyricsForAlign(row.artist ?? '', row.title, row.durationSec ?? undefined)
    if (!lyrics) {
      // No lyrics to align (instrumental / not found). Mark 'failed' with a sentinel — NOT
      // 'none' — so the lazy "align on open" trigger treats this as attempted and doesn't
      // re-enqueue forever. The UI just shows whatever LRCLIB has (nothing here).
      await db.update(musicStudioTracks).set({ lyricsAlignStatus: 'failed', lyricsAlignError: 'no-lyrics', updatedAt: new Date() }).where(eq(musicStudioTracks.id, studioTrackId))
      logger.info(`[align] ${studioTrackId}: no lyrics to align`)
      return
    }

    // vocals stem path: music/studio/<id>/stems/vocals.mp3 (sibling of source.<ext>).
    const vocals = await resolveUserPath(join(row.sourceRelPath.replace(/[^/]+$/, ''), 'stems', 'vocals.mp3'))
    tmp = await mkdtemp(join(tmpdir(), 'lyricalign-'))
    const textFile = join(tmp, 'lyrics.txt')
    await writeFile(textFile, lyrics, 'utf8')

    // First align on this machine pulls the ~1.2 GB MMS model (quietly, here — not via a boot
    // prompt). Cached thereafter.
    onProgress?.({ completed: 10, total: 100, speedBps: 0, etaSeconds: 0, note: 'Preparing alignment model…' })
    await ensureLyricAlignModel((s) => onProgress?.({ completed: 12, total: 100, speedBps: 0, etaSeconds: 0, note: s }), signal)

    onProgress?.({ completed: 20, total: 100, speedBps: 0, etaSeconds: 0, note: 'Aligning lyrics to vocals…' })
    const m = await runAlign(stemVenvPython(), vocals, textFile, signal)
    if (!m.lines?.length) throw new Error('aligner returned no lines')

    // Cross-check against LRCLIB's own synced timing (same cached lookup as plainLyricsForAlign
    // above, so this is a warm read): confirms our alignment / repairs misfired lines when it's
    // clearly the same recording, and is ignored outright for covers/re-records.
    const synced = await syncedLyricsForAlign(row.artist ?? '', row.title, row.durationSec ?? undefined)
    const result = reconcile(m.lines, synced)

    await db.update(musicStudioTracks).set({
      lyricsAlignStatus: 'ready', lyricsAlignError: null,
      lyricsJson: JSON.stringify(result.lines), updatedAt: new Date(),
    }).where(eq(musicStudioTracks.id, studioTrackId))
    onProgress?.({ completed: 100, total: 100, speedBps: 0, etaSeconds: 0, note: 'Lyrics aligned' })
    logger.info(`[align] ${studioTrackId}: ready (${m.lines.length} lines, ${m.alignedWords ?? '?'}/${m.totalWords ?? '?'} words, `
      + `source=${result.source} matchedFrac=${result.matchedFrac.toFixed(2)} offset=${result.offsetSec.toFixed(2)}s)`)
  } catch (err) {
    await db.update(musicStudioTracks)
      .set({ lyricsAlignStatus: 'failed', lyricsAlignError: String(err), updatedAt: new Date() })
      .where(eq(musicStudioTracks.id, studioTrackId))
    throw err
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
