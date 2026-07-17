// Episode transcripts, end to end: normalize Podcasting 2.0 transcript documents
// (SRT / VTT / JSON) into ONE canonical timestamped-segments shape, cache them per
// episode in podcast_transcripts, and mirror each segment into the
// podcast_transcript_fts FTS5 index that powers library-wide search, ask-the-episode
// retrieval, and snips.

import { eq } from 'drizzle-orm'
import { db, sqlite } from '@/db'
import { podcastEpisodes, podcastTranscripts } from '@/db/schema'
import { safeFetch } from '@/lib/ssrfGuard'
import { logger } from '@/lib/logger'

export interface TranscriptSegment {
  startSec: number
  endSec: number
  text: string
  speaker?: string
}

export interface EpisodeTranscript {
  episodeId: string
  source: 'feed' | 'whisper'
  format: string | null
  status: 'pending' | 'processing' | 'ready' | 'failed'
  error: string | null
  segments: TranscriptSegment[]
}

const FETCH_TIMEOUT_MS = 20_000
const MAX_DOC_BYTES = 8 * 1024 * 1024
// Panel-line merge targets: keep readable paragraph-ish lines out of word/caption cues.
const MERGE_MAX_CHARS = 220
const MERGE_MAX_SECONDS = 30
const MERGE_MAX_GAP_SECONDS = 2.5

// ── Format normalizers ─────────────────────────────────────────────────────────────

/** "HH:MM:SS.mmm", "MM:SS.mmm" (VTT) or "HH:MM:SS,mmm" (SRT) → seconds. */
function parseClock(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/)
  if (!m) {
    const secs = Number(raw.trim())
    return Number.isFinite(secs) && secs >= 0 ? secs : null
  }
  const h = m[1] ? Number.parseInt(m[1], 10) : 0
  const min = Number.parseInt(m[2]!, 10)
  const s = Number.parseInt(m[3]!, 10)
  const ms = Number.parseInt(m[4]!.padEnd(3, '0'), 10)
  return h * 3600 + min * 60 + s + ms / 1000
}

function cleanCueText(raw: string): { text: string; speaker?: string } {
  let text = raw
  let speaker: string | undefined
  // WebVTT voice spans: <v Alice>text</v>
  const v = text.match(/<v(?:\.[^\s>]*)?\s+([^>]+)>/i)
  if (v) speaker = v[1]!.trim()
  text = text
    .replace(/<[^>]+>/g, '')            // cue markup (<v>, <c>, <i>, timestamps)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // "Alice: hello" prefix (common in SRT transcripts)
  if (!speaker) {
    const sp = text.match(/^([A-Z][\w .'-]{1,40}):\s+(.+)$/)
    if (sp && sp[1]!.split(' ').length <= 4) { speaker = sp[1]!.trim(); text = sp[2]!.trim() }
  }
  return { text, speaker }
}

/** Cue-based formats (VTT with '.', SRT with ',') share one block parser. */
function parseCueDoc(doc: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  const blocks = doc.replace(/\r/g, '').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '')
    const timeIdx = lines.findIndex(l => l.includes('-->'))
    if (timeIdx < 0) continue
    const [a, b] = lines[timeIdx]!.split('-->')
    if (!a || !b) continue
    const start = parseClock(a)
    const end = parseClock(b.trim().split(/\s+/)[0] ?? '')
    if (start == null || end == null) continue
    const { text, speaker } = cleanCueText(lines.slice(timeIdx + 1).join(' '))
    if (!text) continue
    out.push({ startSec: start, endSec: Math.max(end, start), text, ...(speaker ? { speaker } : {}) })
  }
  return out
}

/** Podcasting 2.0 JSON transcript: { segments: [{ startTime, endTime, body, speaker }] }
 *  (also tolerates a bare array, and start/end/text key variants seen in the wild). */
function parseJsonDoc(doc: string): TranscriptSegment[] {
  let parsed: unknown
  try { parsed = JSON.parse(doc) } catch { return [] }
  const list = Array.isArray(parsed) ? parsed : (parsed as { segments?: unknown })?.segments
  if (!Array.isArray(list)) return []
  const out: TranscriptSegment[] = []
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const start = Number(o.startTime ?? o.start ?? o.startSec)
    const rawEnd = Number(o.endTime ?? o.end ?? o.endSec)
    const text = String(o.body ?? o.text ?? '').replace(/\s+/g, ' ').trim()
    if (!Number.isFinite(start) || start < 0 || !text) continue
    const speaker = typeof o.speaker === 'string' && o.speaker.trim() ? o.speaker.trim() : undefined
    out.push({ startSec: start, endSec: Number.isFinite(rawEnd) && rawEnd >= start ? rawEnd : start, text, ...(speaker ? { speaker } : {}) })
  }
  return out
}

/** Rolling-caption dedupe + merge tiny cues into readable panel lines. */
export function mergeSegments(raw: TranscriptSegment[]): TranscriptSegment[] {
  const cues = [...raw].sort((a, b) => a.startSec - b.startSec)
  // Rolling VTT captions repeat the previous line; drop exact-tail repeats.
  const deduped: TranscriptSegment[] = []
  for (const cue of cues) {
    const prev = deduped[deduped.length - 1]
    if (prev && (prev.text === cue.text || cue.text.startsWith(prev.text))) {
      const extra = cue.text.slice(prev.text.length).trim()
      prev.endSec = Math.max(prev.endSec, cue.endSec)
      if (extra) prev.text = `${prev.text} ${extra}`
      continue
    }
    deduped.push({ ...cue })
  }
  const out: TranscriptSegment[] = []
  for (const cue of deduped) {
    const prev = out[out.length - 1]
    const canMerge = prev
      && (prev.speaker ?? '') === (cue.speaker ?? '')
      && cue.startSec - prev.endSec <= MERGE_MAX_GAP_SECONDS
      && prev.text.length + cue.text.length + 1 <= MERGE_MAX_CHARS
      && cue.endSec - prev.startSec <= MERGE_MAX_SECONDS
      // A sentence boundary ends the line even when there is room left.
      && !/[.!?]["')\]]?$/.test(prev.text)
    if (canMerge) {
      prev.text = `${prev.text} ${cue.text}`
      prev.endSec = Math.max(prev.endSec, cue.endSec)
    } else {
      out.push({ ...cue })
    }
  }
  return out.map(s => ({
    ...s,
    startSec: Math.round(s.startSec * 100) / 100,
    endSec: Math.round(s.endSec * 100) / 100,
  }))
}

/** Normalize a transcript document of a declared MIME/extension into canonical segments.
 *  The declared MIME is only a hint (publishers mislabel constantly), so every parser is
 *  tried in hint-first order and the first one that actually yields cues wins. The
 *  "did this parse" test runs on the RAW cues, never the merged output: merging happily
 *  collapses a real transcript down to a couple of segments, so thresholding after it
 *  would throw away perfectly good short episodes. */
export function normalizeTranscriptDoc(doc: string, typeHint: string | null, urlHint?: string | null): { format: string; segments: TranscriptSegment[] } | null {
  const hint = `${typeHint ?? ''} ${urlHint ?? ''}`.toLowerCase()
  const attempts: Array<{ format: string; parse: (d: string) => TranscriptSegment[] }> = []
  if (hint.includes('json')) attempts.push({ format: 'json', parse: parseJsonDoc })
  if (hint.includes('vtt')) attempts.push({ format: 'vtt', parse: parseCueDoc })
  if (hint.includes('srt') || hint.includes('subrip')) attempts.push({ format: 'srt', parse: parseCueDoc })
  // Unknown/wrong MIME: sniff the body, then fall back to trying everything.
  if (doc.trimStart().startsWith('{') || doc.trimStart().startsWith('[')) attempts.push({ format: 'json', parse: parseJsonDoc })
  attempts.push({ format: doc.trimStart().startsWith('WEBVTT') ? 'vtt' : 'srt', parse: parseCueDoc })
  attempts.push({ format: 'json', parse: parseJsonDoc })
  for (const a of attempts) {
    const raw = a.parse(doc)
    if (!raw.length) continue
    return { format: a.format, segments: mergeSegments(raw) }
  }
  return null
}

// ── Storage + FTS ─────────────────────────────────────────────────────────────────

function rowToTranscript(row: typeof podcastTranscripts.$inferSelect): EpisodeTranscript {
  let segments: TranscriptSegment[] = []
  if (row.segmentsJson) {
    try { segments = JSON.parse(row.segmentsJson) as TranscriptSegment[] } catch { segments = [] }
  }
  return {
    episodeId: row.episodeId,
    source: row.source as 'feed' | 'whisper',
    format: row.format,
    status: row.status as EpisodeTranscript['status'],
    error: row.error,
    segments,
  }
}

/** (Re)build this episode's rows in podcast_transcript_fts.
 *
 *  One row per canonical segment, deliberately: a hit's start_sec is what "play from
 *  this moment" seeks to, so the indexed unit has to be the unit we can seek to. Coarser
 *  windows (merging segments into bigger blocks for fatter snippets) make every hit
 *  inside a block report the BLOCK's start, which silently sends the listener to the top
 *  of the block instead of the line they searched for. mergeSegments already caps a
 *  segment at ~220 chars / 30s, which is a perfectly good snippet unit anyway. */
export function indexTranscriptFts(episodeId: string, showId: string, segments: TranscriptSegment[]): void {
  const del = sqlite.query('DELETE FROM podcast_transcript_fts WHERE episode_id = ?')
  del.run(episodeId)
  const ins = sqlite.query(
    'INSERT INTO podcast_transcript_fts (text, episode_id, show_id, start_sec, end_sec) VALUES (?, ?, ?, ?, ?)',
  )
  const insertAll = sqlite.transaction(() => {
    for (const s of segments) ins.run(s.text, episodeId, showId, s.startSec, s.endSec)
  })
  insertAll()
}

/** Upsert the canonical transcript for an episode and refresh its search index. */
export async function saveTranscript(
  episodeId: string,
  source: 'feed' | 'whisper',
  format: string,
  segments: TranscriptSegment[],
  requestedBy?: string | null,
): Promise<void> {
  const now = new Date()
  await db.insert(podcastTranscripts).values({
    id: crypto.randomUUID(),
    episodeId,
    source,
    format,
    status: 'ready',
    error: null,
    segmentsJson: JSON.stringify(segments),
    segmentCount: segments.length,
    requestedBy: requestedBy ?? null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [podcastTranscripts.episodeId],
    set: {
      source, format, status: 'ready', error: null,
      segmentsJson: JSON.stringify(segments), segmentCount: segments.length,
      ...(requestedBy !== undefined ? { requestedBy: requestedBy ?? null } : {}),
      updatedAt: now,
    },
  })
  const [ep] = await db.select({ showId: podcastEpisodes.showId }).from(podcastEpisodes)
    .where(eq(podcastEpisodes.id, episodeId))
  if (ep) {
    try { indexTranscriptFts(episodeId, ep.showId, segments) } catch (err) {
      logger.warn(`[podcast-transcript] FTS index failed for ${episodeId}: ${err}`)
    }
  }
}

export async function setTranscriptStatus(
  episodeId: string,
  status: 'pending' | 'processing' | 'failed',
  opts: { source?: 'feed' | 'whisper'; error?: string | null; requestedBy?: string | null } = {},
): Promise<void> {
  const now = new Date()
  await db.insert(podcastTranscripts).values({
    id: crypto.randomUUID(),
    episodeId,
    source: opts.source ?? 'whisper',
    status,
    error: opts.error ?? null,
    requestedBy: opts.requestedBy ?? null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [podcastTranscripts.episodeId],
    set: {
      status,
      error: opts.error ?? null,
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.requestedBy !== undefined ? { requestedBy: opts.requestedBy ?? null } : {}),
      updatedAt: now,
    },
  })
}

/** Fetch + normalize the feed-declared transcript document for an episode. Returns the
 *  ready transcript, or null when the URL is missing/unusable (caller may offer Whisper). */
async function fetchFeedTranscript(episodeId: string, url: string, typeHint: string | null): Promise<EpisodeTranscript | null> {
  try {
    const res = await safeFetch(url, {
      headers: { 'User-Agent': 'LokiDoki/3.0 podcast', Accept: 'application/json, text/vtt, application/srt, */*' },
    }, { timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 5 })
    if (!res.ok) { res.body?.cancel().catch(() => {}); return null }
    const text = await res.text()
    if (!text || text.length > MAX_DOC_BYTES) return null
    const normalized = normalizeTranscriptDoc(text, typeHint, url)
    if (!normalized) return null
    await saveTranscript(episodeId, 'feed', normalized.format, normalized.segments)
    return {
      episodeId, source: 'feed', format: normalized.format, status: 'ready', error: null,
      segments: normalized.segments,
    }
  } catch (err) {
    logger.warn(`[podcast-transcript] feed transcript fetch failed for ${episodeId}: ${err}`)
    return null
  }
}

/** The one read path: cached row when present, else a lazy fetch of the feed-declared
 *  transcript document (cached on success). Null = no transcript from any source yet. */
export async function resolveEpisodeTranscript(episodeId: string): Promise<EpisodeTranscript | null> {
  const [row] = await db.select().from(podcastTranscripts)
    .where(eq(podcastTranscripts.episodeId, episodeId))
  if (row) return rowToTranscript(row)

  const [ep] = await db.select({
    transcriptUrl: podcastEpisodes.transcriptUrl,
    transcriptType: podcastEpisodes.transcriptType,
  }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))
  if (!ep?.transcriptUrl) return null
  return fetchFeedTranscript(episodeId, ep.transcriptUrl, ep.transcriptType)
}

// ── Search ────────────────────────────────────────────────────────────────────────

export interface TranscriptSearchHit {
  episodeId: string
  showId: string
  startSec: number
  endSec: number
  text: string
  snippet: string
  rank: number
}

/** Escape a user query into an FTS5 phrase-per-term MATCH expression. */
export function ftsMatchExpr(query: string): string | null {
  const terms = query.split(/\s+/).map(t => t.replace(/"/g, '')).filter(Boolean).slice(0, 12)
  if (!terms.length) return null
  return terms.map(t => `"${t}"`).join(' ')
}

/** Raw FTS search over every indexed transcript window. Callers filter for
 *  show visibility before returning anything to a user. */
export function searchTranscriptWindows(query: string, limit = 60, episodeId?: string): TranscriptSearchHit[] {
  const match = ftsMatchExpr(query)
  if (!match) return []
  const where = episodeId ? 'podcast_transcript_fts MATCH ? AND episode_id = ?' : 'podcast_transcript_fts MATCH ?'
  const params: (string | number)[] = episodeId ? [match, episodeId, limit] : [match, limit]
  try {
    const rows = sqlite.query(
      `SELECT episode_id AS episodeId, show_id AS showId, start_sec AS startSec, end_sec AS endSec,
              text, snippet(podcast_transcript_fts, 0, '[', ']', ' … ', 14) AS snippet,
              bm25(podcast_transcript_fts) AS rank
       FROM podcast_transcript_fts
       WHERE ${where}
       ORDER BY rank LIMIT ?`,
    ).all(...params) as TranscriptSearchHit[]
    return rows.map(r => ({ ...r, startSec: Number(r.startSec), endSec: Number(r.endSec), rank: Number(r.rank) }))
  } catch (err) {
    logger.warn(`[podcast-transcript] FTS search failed: ${err}`)
    return []
  }
}

/** Plain text of a transcript (for LLM context building). */
export function transcriptPlainText(segments: TranscriptSegment[]): string {
  return segments.map(s => s.text).join(' ')
}

export function fmtStamp(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
