// Snips: "Clip that" captures the transcript around the current playback position,
// snapped to segment boundaries, LLM-titles and summarizes it, and saves it with the
// episode reference + timestamp so the library can deep-link back into playback.
// Each snip also gets a companion Note (the household's knowledge store) linking back
// to the moment, so clipped ideas are searchable alongside everything else the family
// writes down. Note creation is best-effort: the snip is the source of truth.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { notes, podcastEpisodes, podcastShows, podcastSnips } from '@/db/schema'
import { titleSnip } from '@/lib/podcast/ai'
import { fmtStamp, resolveEpisodeTranscript, type TranscriptSegment } from '@/lib/podcast/transcripts'
import { logger } from '@/lib/logger'

/** How much transcript a clip captures either side of the position, before snapping. */
export const SNIP_WINDOW_SEC = 30

export interface SnipRecord {
  id: string
  episodeId: string
  episodeTitle: string
  showId: string
  showName: string
  startSec: number
  endSec: number
  title: string
  summary: string | null
  transcriptText: string
  noteId: string | null
  createdAt: Date
}

/** The segments overlapping [positionSec - window, positionSec + window], snapped out
 *  to whole segment boundaries so a clip never starts or ends mid-sentence. */
export function windowSegments(segments: TranscriptSegment[], positionSec: number, windowSec = SNIP_WINDOW_SEC): TranscriptSegment[] {
  const from = positionSec - windowSec
  const to = positionSec + windowSec
  const hit = segments.filter(s => s.endSec >= from && s.startSec <= to)
  if (hit.length) return hit
  // Between segments (a silence, or past the end): fall back to the nearest one.
  let nearest: TranscriptSegment | null = null
  let best = Infinity
  for (const s of segments) {
    const d = Math.min(Math.abs(s.startSec - positionSec), Math.abs(s.endSec - positionSec))
    if (d < best) { best = d; nearest = s }
  }
  return nearest ? [nearest] : []
}

/** Capture, title, and store a snip. Throws with a user-facing message when the
 *  episode has no transcript to clip from. */
export async function createSnip(userId: string, episodeId: string, positionSec: number): Promise<SnipRecord> {
  const transcript = await resolveEpisodeTranscript(episodeId)
  if (!transcript || transcript.status !== 'ready' || !transcript.segments.length) {
    throw new Error('This episode has no transcript to clip from yet')
  }
  const [episode] = await db.select({
    id: podcastEpisodes.id, title: podcastEpisodes.title, showId: podcastEpisodes.showId,
  }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))
  if (!episode) throw new Error('Unknown episode')
  const [show] = await db.select({ name: podcastShows.name }).from(podcastShows).where(eq(podcastShows.id, episode.showId))

  const window = windowSegments(transcript.segments, positionSec)
  if (!window.length) throw new Error('Nothing to clip at this moment')
  const startSec = Math.max(0, window[0]!.startSec)
  const endSec = window[window.length - 1]!.endSec
  const transcriptText = window.map(s => s.text).join(' ').slice(0, 8000)

  const { title, summary } = await titleSnip(episode.title, startSec, transcriptText)

  const now = new Date()
  const id = crypto.randomUUID()
  const noteId = await createSnipNote(userId, {
    title, summary, transcriptText, startSec,
    episodeId, episodeTitle: episode.title, showName: show?.name ?? 'Podcast',
  })

  await db.insert(podcastSnips).values({
    id, userId, episodeId,
    startSec, endSec,
    title, summary, transcriptText,
    noteId,
    createdAt: now,
  })

  return {
    id, episodeId, episodeTitle: episode.title,
    showId: episode.showId, showName: show?.name ?? 'Podcast',
    startSec, endSec, title, summary, transcriptText, noteId, createdAt: now,
  }
}

/** Mirror a snip into the notes system (source='companion': machine-authored). The
 *  note body deep-links back to the episode at the snip's timestamp. Returns null when
 *  the note could not be written; the snip itself still stands on its own. */
async function createSnipNote(userId: string, snip: {
  title: string
  summary: string | null
  transcriptText: string
  startSec: number
  episodeId: string
  episodeTitle: string
  showName: string
}): Promise<string | null> {
  try {
    const now = new Date()
    const id = crypto.randomUUID()
    const link = `/podcasts/episode/${snip.episodeId}?t=${Math.floor(snip.startSec)}`
    const body = [
      snip.summary ?? '',
      '',
      `> ${snip.transcriptText}`,
      '',
      `From [${snip.showName}: ${snip.episodeTitle}](${link}) at ${fmtStamp(snip.startSec)}`,
    ].filter((l, i) => !(i === 0 && !l)).join('\n')
    await db.insert(notes).values({
      id,
      ownerId: userId,
      notebookId: null,
      title: snip.title,
      body,
      tagsText: 'podcast snip',
      pinned: false,
      source: 'companion',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    return id
  } catch (err) {
    logger.warn(`[podcast-snips] note creation failed: ${err}`)
    return null
  }
}

/** This user's snips, newest first, joined to their episode + show for the library. */
export async function listSnips(userId: string, filter: { episodeId?: string } = {}): Promise<SnipRecord[]> {
  const rows = await db.select({
    id: podcastSnips.id,
    episodeId: podcastSnips.episodeId,
    startSec: podcastSnips.startSec,
    endSec: podcastSnips.endSec,
    title: podcastSnips.title,
    summary: podcastSnips.summary,
    transcriptText: podcastSnips.transcriptText,
    noteId: podcastSnips.noteId,
    createdAt: podcastSnips.createdAt,
    episodeTitle: podcastEpisodes.title,
    showId: podcastShows.id,
    showName: podcastShows.name,
  }).from(podcastSnips)
    .innerJoin(podcastEpisodes, eq(podcastSnips.episodeId, podcastEpisodes.id))
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(filter.episodeId
      ? and(eq(podcastSnips.userId, userId), eq(podcastSnips.episodeId, filter.episodeId))
      : eq(podcastSnips.userId, userId))
  return rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(r => ({ ...r, startSec: Number(r.startSec), endSec: Number(r.endSec) }))
}

/** Delete a snip (and the note it created, if it still exists and is still that note). */
export async function deleteSnip(userId: string, snipId: string): Promise<boolean> {
  const [row] = await db.select({ id: podcastSnips.id, noteId: podcastSnips.noteId }).from(podcastSnips)
    .where(and(eq(podcastSnips.id, snipId), eq(podcastSnips.userId, userId)))
  if (!row) return false
  await db.delete(podcastSnips).where(eq(podcastSnips.id, snipId))
  if (row.noteId) {
    // The companion-authored note this snip created goes with it. Scoped to the owner
    // and to source='companion' so a hand-written note can never be caught by this.
    await db.delete(notes)
      .where(and(eq(notes.id, row.noteId), eq(notes.ownerId, userId), eq(notes.source, 'companion')))
      .catch(() => {})
  }
  return true
}
