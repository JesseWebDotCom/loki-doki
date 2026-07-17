// LLM ad detection over an episode's transcript, as a background job (download-jobs
// type 'podcast-ad-scan', compute lane). The scan reads the verbatim timestamped
// transcript in overlapping windows, asks the model for ad ranges, and lands merged,
// sanity-checked segments in podcast_ad_scans. Playback never cuts audio; the player
// seeks past the stored ranges client-side, so a wrong detection is always reversible
// (podcast_ad_reports 'not_ad' rows suppress ranges at serve time).

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs, podcastAdReports, podcastAdScans, podcastEpisodes, podcastShowSettings, userPreferences } from '@/db/schema'
import { getScriptModel } from '@/lib/models'
import { structuredCall } from '@/llm/structured'
import { fmtStamp, resolveEpisodeTranscript, type TranscriptSegment } from '@/lib/podcast/transcripts'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

export interface PodcastAdScanPayload { episodeId: string }

export interface AdSegment {
  id: string
  startSec: number
  endSec: number
  kind: 'sponsor' | 'ad' | 'promo'
  confidence: number
}

export type AdScanStatus = 'none' | 'pending' | 'processing' | 'ready' | 'failed'

// Window sizing: ~16k chars of timestamped lines per LLM call keeps well inside the
// context budget; ~90s of segment overlap between windows so a window break never
// lands inside an ad read (the merge pass dedupes the doubled detections).
const WINDOW_CHARS = 16_000
const WINDOW_OVERLAP_SEC = 90
// Detection guards: low-confidence, implausibly short, and implausibly long ranges
// are dropped; nearby ranges merge; the total is capped defensively.
const MIN_CONFIDENCE = 0.65
const MIN_AD_SEC = 8
const MAX_AD_SEC = 600
const MERGE_GAP_SEC = 15
const MAX_SEGMENTS = 30
const SNAP_SEC = 10
// A detected segment overlapped by a 'not_ad' report beyond this share is suppressed.
const SUPPRESS_OVERLAP = 0.5

export const adScanJobRefId = (episodeId: string) =>
  JSON.stringify({ episodeId } satisfies PodcastAdScanPayload)

const AD_SCAN_SYSTEM =
  'You find advertising segments in a podcast transcript excerpt. Return JSON with exactly one key "ads": an ' +
  'array of objects {"startSec": number, "endSec": number, "kind": "sponsor" | "ad" | "promo", "confidence": ' +
  'number between 0 and 1}. An ad is a host-read sponsor message, an inserted commercial break, a discount code ' +
  'or promo URL read, or a promotion for another show. Editorial discussion of a product or company as the topic ' +
  'of the episode is NOT an ad. startSec and endSec must be taken from the [H:MM:SS] stamps present in the ' +
  'excerpt, converted to whole seconds, with endSec after startSec. Return {"ads": []} when the excerpt contains ' +
  'no ads. Do not use em dashes.'

interface AdScanResponse { ads?: unknown }

interface RawRange { startSec: number; endSec: number; kind: AdSegment['kind']; confidence: number }

async function setScanStatus(
  episodeId: string,
  status: 'pending' | 'processing' | 'ready' | 'failed',
  extra: { error?: string | null; segmentsJson?: string | null; segmentCount?: number | null; model?: string | null; requestedBy?: string | null } = {},
): Promise<void> {
  const now = new Date()
  const set = { status, error: extra.error ?? null, updatedAt: now, ...(
    extra.segmentsJson !== undefined ? { segmentsJson: extra.segmentsJson, segmentCount: extra.segmentCount ?? null, model: extra.model ?? null } : {}
  ) }
  await db.insert(podcastAdScans).values({
    id: crypto.randomUUID(),
    episodeId,
    status,
    error: extra.error ?? null,
    segmentsJson: extra.segmentsJson ?? null,
    segmentCount: extra.segmentCount ?? null,
    model: extra.model ?? null,
    requestedBy: extra.requestedBy ?? null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({ target: [podcastAdScans.episodeId], set })
}

/** Queue an ad scan for an episode (idempotent: an in-flight job is reused; a
 *  finished/failed one is reset). Requires a ready transcript. */
export async function enqueueAdScan(episodeId: string, requestedBy: string | null, opts: { force?: boolean } = {}): Promise<void> {
  const [episode] = await db.select({ id: podcastEpisodes.id, title: podcastEpisodes.title })
    .from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode) throw new Error('Unknown episode')

  const [existing] = await db.select({ status: podcastAdScans.status }).from(podcastAdScans)
    .where(eq(podcastAdScans.episodeId, episodeId)).limit(1)
  if (existing?.status === 'ready' && !opts.force) return

  const { hasReadyTranscript } = await import('@/lib/podcast/ai')
  if (!(await hasReadyTranscript(episodeId))) throw new Error('This episode needs a transcript first.')

  await setScanStatus(episodeId, 'pending', { requestedBy })

  const refId = adScanJobRefId(episodeId)
  const now = new Date()
  const [job] = await db.select().from(downloadJobs)
    .where(and(eq(downloadJobs.type, 'podcast-ad-scan'), eq(downloadJobs.refId, refId))).limit(1)
  if (job) {
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'completed') {
      await db.update(downloadJobs)
        .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, progress: null, updatedAt: now })
        .where(eq(downloadJobs.id, job.id))
    }
  } else {
    await db.insert(downloadJobs).values({
      id: crypto.randomUUID(), type: 'podcast-ad-scan', refId, variantKey: null,
      domain: 'podcast', sizeClass: 'small', label: `Ad scan: ${episode.title.slice(0, 100)}`,
      priority: 75, status: 'pending', attempts: 0, maxAttempts: 2,
      nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
    })
  }
}

/** Terminal-failure/cancel hook so the scan row never sits on 'processing'. */
export async function failPodcastAdScanByJobRefId(refId: string, error: string): Promise<void> {
  let episodeId: string
  try { episodeId = (JSON.parse(refId) as PodcastAdScanPayload).episodeId } catch { return }
  const [row] = await db.select({ status: podcastAdScans.status }).from(podcastAdScans)
    .where(eq(podcastAdScans.episodeId, episodeId)).limit(1)
  if (!row || row.status === 'ready') return
  await setScanStatus(episodeId, 'failed', { error: error.slice(0, 300) })
}

/** Chain gate used after transcription: scan only when someone in the household would
 *  actually skip ads on this show, so auto-transcribed episodes never burn LLM time
 *  that nobody asked for. "Would skip" mirrors the client's effective value: a per-show
 *  force-on (skip_ads = 1), or the global podcasts.skipAds preference on for a user who
 *  has not turned it off (skip_ads = 0) for this show. Best-effort (callers catch). */
export async function maybeEnqueueAdScanForEpisode(episodeId: string): Promise<void> {
  const [episode] = await db.select({ showId: podcastEpisodes.showId })
    .from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode?.showId) return

  const rows = await db.select({ userId: podcastShowSettings.userId, skipAds: podcastShowSettings.skipAds })
    .from(podcastShowSettings).where(eq(podcastShowSettings.showId, episode.showId))
  // Anyone forcing it on for this show.
  if (rows.some(r => r.skipAds === 1)) { await enqueueAdScan(episodeId, null); return }

  // Otherwise honor the global default for anyone who has not forced this show off.
  const forcedOff = new Set(rows.filter(r => r.skipAds === 0).map(r => r.userId))
  const globalOn = await db.select({ userId: userPreferences.userId }).from(userPreferences)
    .where(and(eq(userPreferences.key, 'podcasts.skipAds'), eq(userPreferences.value, 'true')))
  if (globalOn.some(u => !forcedOff.has(u.userId))) await enqueueAdScan(episodeId, null)
}

/** Split the transcript into overlapping windows of timestamped lines. */
function buildWindows(segments: TranscriptSegment[]): { text: string; startSec: number; endSec: number }[] {
  const windows: { text: string; startSec: number; endSec: number }[] = []
  let i = 0
  while (i < segments.length) {
    const startIdx = i
    let used = 0
    const lines: string[] = []
    while (i < segments.length) {
      const s = segments[i]!
      const line = `[${fmtStamp(s.startSec)}] ${s.text}`
      if (used + line.length + 1 > WINDOW_CHARS && lines.length) break
      lines.push(line)
      used += line.length + 1
      i++
    }
    const startSec = segments[startIdx]!.startSec
    const endSec = segments[i - 1]!.endSec
    windows.push({ text: lines.join('\n'), startSec, endSec })
    if (i >= segments.length) break
    // Step back so the next window re-reads the overlap span.
    const overlapFrom = endSec - WINDOW_OVERLAP_SEC
    let back = i
    while (back > startIdx + 1 && segments[back - 1]!.startSec > overlapFrom) back--
    i = Math.max(back, startIdx + 1)
  }
  return windows
}

function normalizeWindowAds(raw: unknown, windowStart: number, windowEnd: number, durationSec: number | null): RawRange[] {
  if (!Array.isArray(raw)) return []
  const out: RawRange[] = []
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue
    const o = a as Record<string, unknown>
    const startSec = Math.round(Number(o.startSec ?? o.start))
    const endSec = Math.round(Number(o.endSec ?? o.end))
    const confidence = Number(o.confidence)
    const kind = String(o.kind) === 'sponsor' ? 'sponsor' : String(o.kind) === 'promo' ? 'promo' : 'ad'
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) continue
    // A stamp the model never saw in this window is a hallucination, not a detection.
    if (startSec < windowStart - SNAP_SEC || endSec > windowEnd + SNAP_SEC) continue
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) continue
    const len = endSec - startSec
    if (len < MIN_AD_SEC || len > MAX_AD_SEC) continue
    if (durationSec && startSec > durationSec) continue
    out.push({
      startSec: Math.max(0, startSec),
      endSec: durationSec ? Math.min(endSec, durationSec) : endSec,
      kind,
      confidence,
    })
  }
  return out
}

/** Snap a boundary to the nearest transcript segment edge within SNAP_SEC, so skips
 *  land on speech boundaries instead of mid-word. */
function snapToSegments(sec: number, segments: TranscriptSegment[], edge: 'start' | 'end'): number {
  let best = sec
  let bestDist = SNAP_SEC + 1
  for (const s of segments) {
    const candidate = edge === 'start' ? s.startSec : s.endSec
    const dist = Math.abs(candidate - sec)
    if (dist < bestDist) { best = candidate; bestDist = dist }
    if (s.startSec > sec + SNAP_SEC) break
  }
  return Math.round(best)
}

function mergeRanges(ranges: RawRange[]): RawRange[] {
  const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec)
  const merged: RawRange[] = []
  for (const r of sorted) {
    const prev = merged[merged.length - 1]
    if (prev && r.startSec <= prev.endSec + MERGE_GAP_SEC) {
      prev.endSec = Math.max(prev.endSec, r.endSec)
      prev.confidence = Math.max(prev.confidence, r.confidence)
    } else {
      merged.push({ ...r })
    }
  }
  return merged.slice(0, MAX_SEGMENTS)
}

/** The job runner: windows over the verbatim transcript, one structured LLM call per
 *  window, then normalize + merge + save. Zero detected ads is a valid ready result. */
export async function runPodcastAdScanJob(
  payload: PodcastAdScanPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { episodeId } = payload
  const [episode] = await db.select({
    id: podcastEpisodes.id, title: podcastEpisodes.title, durationSec: podcastEpisodes.durationSec,
  }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode) throw new Error(`Unknown episode ${episodeId}`)

  const transcript = await resolveEpisodeTranscript(episodeId)
  if (!transcript || transcript.status !== 'ready' || !transcript.segments.length) {
    throw new Error('This episode has no transcript yet')
  }

  await setScanStatus(episodeId, 'processing')

  try {
    const model = await getScriptModel()
    const windows = buildWindows(transcript.segments)
    const total = fmtStamp(episode.durationSec ?? transcript.segments[transcript.segments.length - 1]!.endSec)
    const ranges: RawRange[] = []

    for (let w = 0; w < windows.length; w++) {
      if (signal.aborted) throw new Error('Aborted')
      const win = windows[w]!
      onProgress({
        completed: w, total: windows.length, speedBps: 0, etaSeconds: 0,
        note: `Scanning for ads ${Math.round((w / windows.length) * 100)}%`,
      })
      const prompt = [
        `Episode title: ${episode.title}`,
        `This excerpt covers [${fmtStamp(win.startSec)}] to [${fmtStamp(win.endSec)}] of a [${total}] episode.`,
        '',
        'Transcript (each line is prefixed with its start time):',
        win.text,
      ].join('\n')
      const res = await structuredCall<AdScanResponse>(model, prompt, AD_SCAN_SYSTEM, { num_predict: 600 })
      ranges.push(...normalizeWindowAds(res.ads, win.startSec, win.endSec, episode.durationSec))
    }

    const snapped = ranges.map(r => ({
      ...r,
      startSec: snapToSegments(r.startSec, transcript.segments, 'start'),
      endSec: snapToSegments(r.endSec, transcript.segments, 'end'),
    })).filter(r => r.endSec - r.startSec >= MIN_AD_SEC)

    const segments: AdSegment[] = mergeRanges(snapped).map(r => ({ id: crypto.randomUUID(), ...r }))

    await setScanStatus(episodeId, 'ready', {
      segmentsJson: JSON.stringify(segments),
      segmentCount: segments.length,
      model,
    })
    onProgress({ completed: windows.length, total: windows.length, speedBps: 0, etaSeconds: 0, note: 'Ad scan ready' })
    logger.info(`[podcast-ad-scan] "${episode.title}": ${segments.length} ad segment(s) across ${windows.length} window(s)`)
  } catch (err) {
    // Retries re-enter through the scheduler; the terminal-failure hook flips the row
    // to 'failed'. Reset to 'pending' here so the UI shows "queued" between attempts.
    await setScanStatus(episodeId, 'pending', { error: String(err).slice(0, 300) }).catch(() => {})
    throw err
  }
}

/** Serving read: parsed segments with household 'not_ad' corrections applied. */
export async function getAdSegments(episodeId: string): Promise<{ status: AdScanStatus; error: string | null; segments: AdSegment[] }> {
  const [row] = await db.select().from(podcastAdScans).where(eq(podcastAdScans.episodeId, episodeId)).limit(1)
  if (!row) return { status: 'none', error: null, segments: [] }
  if (row.status !== 'ready' || !row.segmentsJson) {
    return { status: row.status, error: row.error, segments: [] }
  }

  let segments: AdSegment[] = []
  try {
    const parsed = JSON.parse(row.segmentsJson) as unknown
    if (Array.isArray(parsed)) segments = parsed as AdSegment[]
  } catch { /* treat unparseable JSON as no segments */ }

  const reports = await db.select().from(podcastAdReports)
    .where(and(eq(podcastAdReports.episodeId, episodeId), eq(podcastAdReports.kind, 'not_ad')))
  if (reports.length) {
    segments = segments.filter(seg => {
      const len = Math.max(seg.endSec - seg.startSec, 1)
      for (const r of reports) {
        const overlap = Math.min(seg.endSec, r.endSec) - Math.max(seg.startSec, r.startSec)
        if (overlap / len > SUPPRESS_OVERLAP) return false
      }
      return true
    })
  }
  return { status: 'ready', error: null, segments }
}
