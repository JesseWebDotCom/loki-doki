// Media segments: typed time-spans on a video that a player can act on. Jellyfin's model
// (its 10.10 Media Segments API), and the right shape for us because we already have TWO
// producers of "skip this part" data that were solving it separately:
//
//   • SponsorBlock (sponsor/intro/selfpromo on YouTube) - community data, already shipping
//   • intro/credits/recap on Plex + local episodes - detected here
//
// One model means one skip affordance in the players instead of per-source chrome.
//
// Detection strategy for local/Plex content: audio-fingerprint intro matching (what Plex
// Pass and Jellyfin's Intro Skipper do) needs the whole season on disk and a chromaprint
// pass; that is a much larger build. What ships here is the honest subset: CHAPTER-derived
// segments, which cover the common cases well because most encoded TV/film carries chapter
// marks, and creators/rippers name them ("Intro", "Opening Credits", "End Credits").
// ffprobe reads them in ~50ms with no decode. Videos with no chapters yield nothing rather
// than a guess, and the player simply shows no skip button.

import { spawn } from 'node:child_process'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { mediaSegments } from '@/db/schema'
import { ffprobeBin } from '@/lib/ffmpeg'
import { logger } from '@/lib/logger'

export type SegmentType = 'intro' | 'credits' | 'recap' | 'preview' | 'sponsor'

export interface MediaSegment {
  type: SegmentType
  startSec: number
  endSec: number
}

/** Chapter titles → segment types. Matched case-insensitively on the whole title. */
const TITLE_PATTERNS: Array<{ re: RegExp; type: SegmentType }> = [
  { re: /^(intro|opening|opening credits|op|title sequence|main titles?)$/i, type: 'intro' },
  { re: /\b(intro|opening credits|title sequence)\b/i, type: 'intro' },
  { re: /^(end credits|credits|ending|outro|ed)$/i, type: 'credits' },
  { re: /\b(end credits|closing credits)\b/i, type: 'credits' },
  { re: /\b(recap|previously on|previously)\b/i, type: 'recap' },
  { re: /\b(preview|next time|next episode)\b/i, type: 'preview' },
]

function classifyChapter(title: string): SegmentType | null {
  const t = title.trim()
  if (!t) return null
  for (const { re, type } of TITLE_PATTERNS) if (re.test(t)) return type
  return null
}

interface ProbeChapter { start_time?: string; end_time?: string; tags?: { title?: string } }

/** ffprobe a file's chapter list (fast: container metadata only, no decode). */
async function probeChapters(absPath: string): Promise<ProbeChapter[]> {
  return new Promise((resolve) => {
    const p = spawn(ffprobeBin(), [
      '-v', 'quiet', '-print_format', 'json', '-show_chapters', absPath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => { out += String(d) })
    p.on('error', () => resolve([]))
    p.on('close', () => {
      try { resolve((JSON.parse(out) as { chapters?: ProbeChapter[] }).chapters ?? []) }
      catch { resolve([]) }
    })
    // ffprobe on a healthy file is ~50ms; a hang means something is wrong with it.
    setTimeout(() => { try { p.kill() } catch { /* already gone */ }; resolve([]) }, 10_000)
  })
}

/** Derive segments from a media file's chapters. Empty when it has none, or none named
 *  like an intro/credits - never guesses from timing alone. */
export async function detectSegmentsFromFile(absPath: string, durationSec?: number | null): Promise<MediaSegment[]> {
  const chapters = await probeChapters(absPath)
  const out: MediaSegment[] = []
  for (const ch of chapters) {
    const title = ch.tags?.title ?? ''
    const type = classifyChapter(title)
    if (!type) continue
    const startSec = Number(ch.start_time)
    const endSec = Number(ch.end_time)
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) continue
    // An "intro" chapter 40 minutes in is mislabelled data, not an intro.
    if (type === 'intro' && durationSec && startSec > durationSec * 0.5) continue
    out.push({ type, startSec: Math.floor(startSec), endSec: Math.ceil(endSec) })
  }
  return out.sort((a, b) => a.startSec - b.startSec)
}

// ── Store ────────────────────────────────────────────────────────────────────────

export async function getSegments(source: string, mediaId: string): Promise<MediaSegment[]> {
  const rows = await db.select().from(mediaSegments)
    .where(and(eq(mediaSegments.source, source), eq(mediaSegments.mediaId, mediaId)))
  return rows
    .map((r) => ({ type: r.type as SegmentType, startSec: r.startSec, endSec: r.endSec }))
    .sort((a, b) => a.startSec - b.startSec)
}

/** Replace the stored segments for one media item. `[]` records "checked, found none",
 *  which is what stops every open from re-probing. */
export async function putSegments(source: string, mediaId: string, segments: MediaSegment[]): Promise<void> {
  const now = new Date()
  await db.delete(mediaSegments)
    .where(and(eq(mediaSegments.source, source), eq(mediaSegments.mediaId, mediaId)))
  if (segments.length) {
    await db.insert(mediaSegments).values(segments.map((s) => ({
      id: crypto.randomUUID(), source, mediaId,
      type: s.type, startSec: s.startSec, endSec: s.endSec, updatedAt: now,
    })))
  } else {
    // Sentinel row: type 'none' with a zero span. Filtered out of getSegments by its
    // unknown type never matching a player action, but it proves detection ran.
    await db.insert(mediaSegments).values({
      id: crypto.randomUUID(), source, mediaId,
      type: 'none', startSec: 0, endSec: 0, updatedAt: now,
    })
  }
}

export async function segmentsChecked(source: string, mediaId: string): Promise<boolean> {
  const [row] = await db.select({ id: mediaSegments.id }).from(mediaSegments)
    .where(and(eq(mediaSegments.source, source), eq(mediaSegments.mediaId, mediaId))).limit(1)
  return !!row
}

/** Detect + store in the background the first time a media item is opened. */
export function ensureSegments(source: string, mediaId: string, absPath: string, durationSec?: number | null): void {
  void (async () => {
    try {
      if (await segmentsChecked(source, mediaId)) return
      const segments = await detectSegmentsFromFile(absPath, durationSec)
      await putSegments(source, mediaId, segments)
      if (segments.length) logger.debug(`[mediaSegments] ${source}:${mediaId} → ${segments.map((s) => s.type).join(', ')}`)
    } catch (err) {
      logger.debug(`[mediaSegments] detect failed for ${source}:${mediaId}: ${String(err)}`)
    }
  })()
}
