// Trickplay: scrubber preview thumbnails for content YouTube doesn't hand us storyboards
// for (Plex playback, offline saves, studio renders). One ffmpeg pass builds a sprite
// sheet of frames at a fixed interval; the player reuses the SAME StoryboardPreview
// component the YouTube path already uses, just pointed at our sheet instead of Google's.
//
// Jellyfin 10.10 made this ~100x faster by extracting keyframes only; the same trick
// applies here (-skip_frame nokey), so a 45-minute episode costs a few seconds rather
// than a full decode. Generation is lazy (first scrub of a given item) and cached on disk
// forever: a file's frames never change.

import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ffmpegBin } from '@/lib/ffmpeg'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'

// One sheet, 10 columns; interval scales with duration so the sheet stays bounded.
const COLS = 10
const TILE_W = 160
const TILE_H = 90
const MAX_TILES = 200

export interface TrickplayInfo {
  /** Client-facing URL of the sprite sheet. */
  url: string
  intervalSec: number
  cols: number
  rows: number
  tileWidth: number
  tileHeight: number
  totalCount: number
}

function sheetPath(source: string, mediaId: string): string {
  const safe = `${source}_${mediaId}`.replace(/[^\w.-]/g, '_')
  return join(dataDir, 'trickplay', `${safe}.jpg`)
}

async function exists(p: string): Promise<boolean> {
  try { return (await stat(p)).size > 0 } catch { return false }
}

// One generation per (source, mediaId) at a time: two scrubs racing the same file would
// otherwise run two ffmpeg passes over it.
const inFlight = new Map<string, Promise<TrickplayInfo | null>>()

export function generateTrickplay(source: string, mediaId: string, absPath: string, durationSec: number): Promise<TrickplayInfo | null> {
  const key = `${source}:${mediaId}`
  const running = inFlight.get(key)
  if (running) return running
  const p = run(source, mediaId, absPath, durationSec).finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

function infoFor(source: string, mediaId: string, durationSec: number): TrickplayInfo {
  const intervalSec = Math.max(2, Math.ceil(durationSec / MAX_TILES))
  const totalCount = Math.max(1, Math.floor(durationSec / intervalSec))
  return {
    url: `/api/videos/trickplay/${encodeURIComponent(source)}/${encodeURIComponent(mediaId)}/sheet.jpg`,
    intervalSec, cols: COLS, rows: Math.ceil(totalCount / COLS),
    tileWidth: TILE_W, tileHeight: TILE_H, totalCount,
  }
}

async function run(source: string, mediaId: string, absPath: string, durationSec: number): Promise<TrickplayInfo | null> {
  if (!durationSec || durationSec < 30) return null
  const out = sheetPath(source, mediaId)
  const info = infoFor(source, mediaId, durationSec)
  if (await exists(out)) return info

  await mkdir(join(dataDir, 'trickplay'), { recursive: true })
  // -skip_frame nokey: decode keyframes only (Jellyfin's trick). fps filter picks one
  // frame per interval; tile packs them into a single sheet.
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-skip_frame', 'nokey', '-i', absPath,
    '-vf', `fps=1/${info.intervalSec},scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=increase,crop=${TILE_W}:${TILE_H},tile=${COLS}x${info.rows}`,
    '-frames:v', '1', '-q:v', '5', '-y', out,
  ]
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('error', () => resolve(false))
    p.on('close', (code) => {
      if (code !== 0 && err) logger.debug(`[trickplay] ffmpeg ${source}:${mediaId} → ${err.slice(0, 200)}`)
      resolve(code === 0)
    })
    // A big remote Plex file over a slow mount can be slow; still bounded.
    setTimeout(() => { try { p.kill() } catch { /* gone */ }; resolve(false) }, 120_000)
  })
  if (!ok || !(await exists(out))) return null
  logger.debug(`[trickplay] built ${source}:${mediaId} (${info.totalCount} tiles)`)
  return info
}

export function trickplaySheetPath(source: string, mediaId: string): string {
  return sheetPath(source, mediaId)
}
