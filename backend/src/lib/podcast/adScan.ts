// LLM ad detection over an episode's transcript, as a background job (download-jobs
// type 'podcast-ad-scan', compute lane). The scan reads the verbatim timestamped
// transcript in overlapping windows, asks the model for ad ranges, and lands merged,
// sanity-checked segments in podcast_ad_scans. Playback never cuts audio; the player
// seeks past the stored ranges client-side, so a wrong detection is always reversible
// (podcast_ad_reports 'not_ad' rows suppress ranges at serve time).

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs, podcastAdReports, podcastAdScans, podcastEpisodes, podcastShowSettings, podcastTranscripts, userPreferences } from '@/db/schema'
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
// Bias toward recall (catch the full ad and every ad): a lenient confidence floor, and
// a generous merge gap so pieces of one ad break (or an LLM hit next to a keyword hit)
// join into a single range instead of leaving gaps of un-skipped ad between them.
const MIN_CONFIDENCE = 0.5
const MIN_AD_SEC = 8
const MAX_AD_SEC = 600
const MERGE_GAP_SEC = 30
const MAX_SEGMENTS = 40
// A detected segment overlapped by a 'not_ad' report beyond this share is suppressed.
const SUPPRESS_OVERLAP = 0.5
// Method 2 (keyword/pattern): strong, high-precision phrases that almost only occur
// inside an ad read. A line hitting one contributes a range even if the model missed it.
// Note spoken URLs ("betterhelp dot com slash smartless") are the most common signal in
// a transcript, since Whisper writes out what the host says. No trailing \b (patterns end
// on punctuation or mid-URL).
const AD_SIGNAL = /\b(?:promo\s?code|use\s+code|coupon\s+code|discount\s+code|brought to you by|sponsored by|this (?:episode|podcast) is sponsored|support (?:for|comes) (?:for )?(?:this (?:show|podcast|episode) )?(?:comes )?from|free trial|\d+\s?(?:%|percent)\s+off|save \d+\s?(?:%|percent)|dot (?:com|co|net|org|io)\s+slash|[a-z0-9-]+\.(?:com|co|net|org|io)\/[a-z]|terms (?:and conditions )?apply|offer (?:ends|expires|valid))/i
// How far (seconds) a keyword hit reaches to capture the surrounding read.
const SIGNAL_REACH_SEC = 30

export const adScanJobRefId = (episodeId: string) =>
  JSON.stringify({ episodeId } satisfies PodcastAdScanPayload)

// The model identifies WHICH numbered lines are ads; the exact start/end times come
// from those transcript lines on our side. Never ask the model for seconds: it cannot
// reliably read a [H:MM:SS] stamp and do the arithmetic, and a small error there put
// the ad markers and auto-skip in the wrong place. Line numbers it can copy verbatim.
// Pass 1: find every ad and, crucially, WHICH sponsor each one is for. The sponsor label
// is what pass 2 uses to read outward and grab the whole read.
const AD_SCAN_SYSTEM =
  'You find EVERY advertising segment in a podcast transcript excerpt. Every line begins with a line number in ' +
  'square brackets, like [42]. Return JSON with exactly one key "ads": an array of objects ' +
  '{"startLine": number, "endLine": number, "sponsor": string, "kind": "sponsor" | "ad" | "promo", "confidence": ' +
  'number between 0 and 1}. Copy startLine and endLine exactly from the brackets, endLine at or after startLine. ' +
  '"sponsor" is the product or brand being advertised (for example "Apple Card", "BetterHelp", "ZipRecruiter"), or ' +
  '"" if you cannot tell. ' +
  'An ad is a host-read sponsor message, an inserted commercial, a discount code or promo URL read, or a ' +
  'promotion for another show. It is fine to mark just the core of the ad here; its exact edges are refined later. ' +
  'An episode usually contains SEVERAL ad breaks, near the start and one or more in the middle. Return all of ' +
  'them, not only the first. ' +
  'Editorial discussion of a product or company as the actual topic of the episode is NOT an ad, and neither is ' +
  'the hosts\' banter. Return {"ads": []} when the excerpt contains no ads. Do not use em dashes.'

// Pass 2: given one ad's sponsor and a tight window around it, return the exact extent of
// THAT single ad read. Deliberately precise, not greedy: over-extending skips real show.
const AD_EXPAND_SYSTEM =
  'You are given a numbered transcript excerpt and told one advertiser whose ad appears in it. Return the exact ' +
  'boundaries of THAT single ad read as JSON {"startLine": number, "endLine": number, "isAd": boolean}. ' +
  'startLine is the first line of the ad, including a short lead-in if present (for example "we will be right ' +
  'back", "this episode is supported by"). endLine is the last line of the ad itself. ' +
  'Be PRECISE, not greedy. Extend only as far as the text is clearly still part of THIS ad. The moment the hosts ' +
  'return to their own conversation, the episode\'s topic, banter, or a guest, the ad is OVER: end it on the ' +
  'previous line. When in doubt, choose the tighter boundary. Never absorb show content, and never include a ' +
  'different advertiser. ' +
  'Copy line numbers exactly from the brackets. Set "isAd" false if the marked lines are not actually an ad. Do ' +
  'not use em dashes.'

// Lines of context on each side of a seed shown to pass 2. Small on purpose: it both fits
// a normal ad read and hard-caps how far pass 2 can over-extend.
const AD_CONTEXT_LINES = 20

interface AdSeed { startIdx: number; endIdx: number; sponsor: string; kind: AdSegment['kind']; confidence: number }

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
  if (episode?.showId && await showWantsSkipAds(episode.showId)) await enqueueAdScan(episodeId, null)
}

/** True when at least one household member would skip ads on this show: a per-show
 *  force-on, or the global podcasts.skipAds default for someone who has not turned the
 *  show off. Mirrors the client's effective value. */
async function showWantsSkipAds(showId: string): Promise<boolean> {
  const rows = await db.select({ userId: podcastShowSettings.userId, skipAds: podcastShowSettings.skipAds })
    .from(podcastShowSettings).where(eq(podcastShowSettings.showId, showId))
  if (rows.some(r => r.skipAds === 1)) return true
  const forcedOff = new Set(rows.filter(r => r.skipAds === 0).map(r => r.userId))
  const globalOn = await db.select({ userId: userPreferences.userId }).from(userPreferences)
    .where(and(eq(userPreferences.key, 'podcasts.skipAds'), eq(userPreferences.value, 'true')))
  return globalOn.some(u => !forcedOff.has(u.userId))
}

/** Called when an episode's download finishes. Dynamically-inserted ads mean a transcript
 *  made from the live stream has a different timeline than the downloaded copy (a longer
 *  or different pre-roll shifts everything), so any transcript/scan made before the
 *  download is stale. For skip-ads shows, drop them and re-transcribe from the now-canonical
 *  downloaded file (which chains back into a fresh scan). No-op for other shows. */
export async function reprocessForSkipAdsAfterDownload(episodeId: string): Promise<void> {
  const [episode] = await db.select({ showId: podcastEpisodes.showId })
    .from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode?.showId || !(await showWantsSkipAds(episode.showId))) return
  await db.delete(podcastAdScans).where(eq(podcastAdScans.episodeId, episodeId))
  await db.delete(podcastTranscripts).where(eq(podcastTranscripts.episodeId, episodeId))
  const { enqueueEpisodeTranscription } = await import('@/lib/podcast/transcribe')
  await enqueueEpisodeTranscription(episodeId, null)
}

/** Whether the episode has a stable local audio copy the player and transcriber both use
 *  (a generated file, or a downloaded blob that is ready). When false, playback and
 *  transcription each fetch the live stream independently, so their timelines can differ. */
export async function episodeHasLocalAudio(episodeId: string): Promise<boolean> {
  const [ep] = await db.select({ assetId: podcastEpisodes.assetId, audioRelPath: podcastEpisodes.audioRelPath })
    .from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!ep) return false
  if (ep.audioRelPath) return true
  if (!ep.assetId) return false
  const { mediaAssets } = await import('@/db/schema')
  const [asset] = await db.select({ status: mediaAssets.status }).from(mediaAssets).where(eq(mediaAssets.id, ep.assetId)).limit(1)
  return asset?.status === 'ready'
}

/** Split the transcript into overlapping windows of line-numbered text. Each line is
 *  prefixed with its GLOBAL segment index in [brackets], so the model's returned line
 *  numbers map straight back to a transcript segment (and thus an exact time). */
function buildWindows(segments: TranscriptSegment[]): { text: string; startIdx: number; endIdx: number }[] {
  const windows: { text: string; startIdx: number; endIdx: number }[] = []
  let i = 0
  while (i < segments.length) {
    const startIdx = i
    let used = 0
    const lines: string[] = []
    while (i < segments.length) {
      const s = segments[i]!
      const line = `[${i}] ${s.text}`
      if (used + line.length + 1 > WINDOW_CHARS && lines.length) break
      lines.push(line)
      used += line.length + 1
      i++
    }
    const endIdx = i - 1
    windows.push({ text: lines.join('\n'), startIdx, endIdx })
    if (i >= segments.length) break
    // Step back so the next window re-reads the overlap span (by time).
    const overlapFrom = segments[endIdx]!.endSec - WINDOW_OVERLAP_SEC
    let back = i
    while (back > startIdx + 1 && segments[back - 1]!.startSec > overlapFrom) back--
    i = Math.max(back, startIdx + 1)
  }
  return windows
}

/** Pass 1: parse the model's ads for one window into line-indexed seeds (with sponsor).
 *  Edges are refined in pass 2, so no length filter here. */
function normalizeWindowSeeds(raw: unknown, windowStart: number, windowEnd: number, segments: TranscriptSegment[]): AdSeed[] {
  if (!Array.isArray(raw)) return []
  const out: AdSeed[] = []
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue
    const o = a as Record<string, unknown>
    let sL = Math.round(Number(o.startLine ?? o.start))
    let eL = Math.round(Number(o.endLine ?? o.end))
    if (!Number.isFinite(sL) || !Number.isFinite(eL)) continue
    if (eL < sL) [sL, eL] = [eL, sL]
    // Clamp to the lines this window actually showed the model; outside = hallucination.
    sL = Math.max(sL, windowStart); eL = Math.min(eL, windowEnd)
    if (eL < sL || !segments[sL] || !segments[eL]) continue
    const confidence = Number(o.confidence)
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) continue
    const kind = String(o.kind) === 'sponsor' ? 'sponsor' : String(o.kind) === 'promo' ? 'promo' : 'ad'
    const sponsor = String(o.sponsor ?? '').replace(/[^\w .&'/-]/g, '').trim().slice(0, 80)
    out.push({ startIdx: sL, endIdx: eL, sponsor, kind, confidence })
  }
  return out
}

/** Combine seeds that point at the same ad (overlapping/adjacent line ranges), so each
 *  distinct ad is expanded once in pass 2. */
function mergeSeeds(seeds: AdSeed[]): AdSeed[] {
  const sorted = [...seeds].sort((a, b) => a.startIdx - b.startIdx)
  const merged: AdSeed[] = []
  for (const s of sorted) {
    const prev = merged[merged.length - 1]
    if (prev && s.startIdx <= prev.endIdx + 3) {
      prev.endIdx = Math.max(prev.endIdx, s.endIdx)
      prev.confidence = Math.max(prev.confidence, s.confidence)
      if (!prev.sponsor && s.sponsor) prev.sponsor = s.sponsor
    } else {
      merged.push({ ...s })
    }
  }
  return merged.slice(0, MAX_SEGMENTS)
}

/** Pass 2: read outward from a seed to the full ad for its sponsor. Returns the widened
 *  line range (always covering the seed), or null if the model says it is not an ad. */
async function expandSeed(seed: AdSeed, segments: TranscriptSegment[], model: string): Promise<{ startIdx: number; endIdx: number } | null> {
  const ctxStart = Math.max(0, seed.startIdx - AD_CONTEXT_LINES)
  const ctxEnd = Math.min(segments.length - 1, seed.endIdx + AD_CONTEXT_LINES)
  const lines: string[] = []
  for (let i = ctxStart; i <= ctxEnd; i++) lines.push(`[${i}] ${segments[i]!.text}`)
  const label = seed.sponsor || 'the advertised product'
  const prompt = [
    `Advertiser: ${label}`,
    `An ad for ${label} is around lines ${seed.startIdx} to ${seed.endIdx}. Find where the whole ad starts and ends.`,
    '',
    'Transcript:',
    lines.join('\n'),
  ].join('\n')
  const res = await structuredCall<{ startLine?: unknown; endLine?: unknown; isAd?: unknown }>(
    model, prompt, AD_EXPAND_SYSTEM, { num_predict: 120 }, 'json')
  if (res.isAd === false) return null
  let sL = Math.round(Number(res.startLine))
  let eL = Math.round(Number(res.endLine))
  if (!Number.isFinite(sL) || !Number.isFinite(eL)) return { startIdx: seed.startIdx, endIdx: seed.endIdx }
  if (eL < sL) [sL, eL] = [eL, sL]
  // Result must cover the seed and stay inside the context it was shown.
  sL = Math.min(seed.startIdx, Math.max(ctxStart, sL))
  eL = Math.max(seed.endIdx, Math.min(ctxEnd, eL))
  if (!segments[sL] || !segments[eL] || eL < sL) return { startIdx: seed.startIdx, endIdx: seed.endIdx }
  return { startIdx: sL, endIdx: eL }
}

/** Method 2: a deterministic keyword/pattern pass over the whole transcript. Every line
 *  carrying a strong ad signal (promo code, "brought to you by", a slash-path URL, ...)
 *  becomes a range grown to the surrounding read, catching ads the model under-marks or
 *  misses entirely. Unioned with the model's ranges (the merge dedupes overlaps). Kept
 *  to high-precision phrases so it does not swallow ordinary conversation. */
function heuristicAdRanges(segments: TranscriptSegment[]): RawRange[] {
  const out: RawRange[] = []
  for (let i = 0; i < segments.length; i++) {
    if (!AD_SIGNAL.test(segments[i]!.text)) continue
    const anchor = segments[i]!
    let lo = i, hi = i
    while (lo > 0 && anchor.startSec - segments[lo - 1]!.startSec <= SIGNAL_REACH_SEC) lo--
    while (hi < segments.length - 1 && segments[hi + 1]!.endSec - anchor.endSec <= SIGNAL_REACH_SEC) hi++
    out.push({ startSec: segments[lo]!.startSec, endSec: segments[hi]!.endSec, kind: 'sponsor', confidence: 0.8 })
  }
  return out
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
    assetId: podcastEpisodes.assetId, enclosureUrl: podcastEpisodes.enclosureUrl, showId: podcastEpisodes.showId,
  }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode) throw new Error(`Unknown episode ${episodeId}`)

  const transcript = await resolveEpisodeTranscript(episodeId)
  if (!transcript || transcript.status !== 'ready' || !transcript.segments.length) {
    throw new Error('This episode has no transcript yet')
  }

  await setScanStatus(episodeId, 'processing')

  try {
    const model = await getScriptModel()
    const segs = transcript.segments
    const windows = buildWindows(segs)
    const total = fmtStamp(episode.durationSec ?? segs[segs.length - 1]!.endSec)
    const ranges: RawRange[] = []

    // ── Pass 1: find each ad's core + its sponsor ──────────────────────────────────
    const seeds: AdSeed[] = []
    let failedWindows = 0
    for (let w = 0; w < windows.length; w++) {
      if (signal.aborted) throw new Error('Aborted')
      const win = windows[w]!
      onProgress({ completed: w, total: windows.length + 1, speedBps: 0, etaSeconds: 0, note: `Scanning for ads ${Math.round((w / (windows.length + 1)) * 100)}%` })
      const prompt = [
        `Episode title: ${episode.title}`,
        `This excerpt is part of a [${total}] episode. Each transcript line begins with its line number in [brackets].`,
        '',
        'Transcript:',
        win.text,
      ].join('\n')
      // format 'json' forces valid JSON; a single window that still fails does not sink
      // the whole episode.
      try {
        const res = await structuredCall<AdScanResponse>(model, prompt, AD_SCAN_SYSTEM, { num_predict: 1200 }, 'json')
        seeds.push(...normalizeWindowSeeds(res.ads, win.startIdx, win.endIdx, segs))
      } catch (err) {
        failedWindows++
        logger.warn(`[podcast-ad-scan] window ${w + 1}/${windows.length} failed: ${String(err).slice(0, 160)}`)
      }
    }
    // If EVERY window failed, the model/endpoint is broken: surface it rather than saving
    // a falsely-empty result.
    if (windows.length > 0 && failedWindows === windows.length) {
      throw new Error(`Ad detection failed on all ${windows.length} transcript window(s); the model returned unparseable output`)
    }

    // ── Pass 2: read outward from each seed to the ad's full extent ────────────────
    const mergedSeeds = mergeSeeds(seeds)
    for (let si = 0; si < mergedSeeds.length; si++) {
      if (signal.aborted) throw new Error('Aborted')
      onProgress({ completed: windows.length, total: windows.length + 1, speedBps: 0, etaSeconds: 0, note: `Refining ad boundaries ${si + 1}/${mergedSeeds.length}` })
      const seed = mergedSeeds[si]!
      let ex: { startIdx: number; endIdx: number } | null
      try { ex = await expandSeed(seed, segs, model) }
      catch { ex = { startIdx: seed.startIdx, endIdx: seed.endIdx } }   // keep the seed on failure
      if (!ex) continue                                                 // pass 2 says: not an ad
      const first = segs[ex.startIdx]; const last = segs[ex.endIdx]
      if (first && last && last.endSec > first.startSec && last.endSec - first.startSec <= MAX_AD_SEC) {
        ranges.push({ startSec: Math.max(0, first.startSec), endSec: last.endSec, kind: seed.kind, confidence: seed.confidence })
      }
    }

    // Method 2: union the deterministic keyword pass so ads the model missed still get
    // caught (the merge below dedupes overlap).
    ranges.push(...heuristicAdRanges(segs))

    // NOTE: the audio two-fetch fingerprint diff (adFingerprint.ts) is DISABLED. In the
    // real world this show re-encodes each fetch, so even the shared content differs
    // between the two copies and the diff flagged almost the whole episode as ad. The
    // module is kept for a future, guarded revival (see AUDIO_DIFF_ENABLED) but is not
    // run: detection is the LLM + keyword passes only.

    // Times already come straight from transcript segment boundaries (no model-computed
    // seconds), so no snapping is needed; just drop anything too short after the merge.
    const snapped = ranges.filter(r => r.endSec - r.startSec >= MIN_AD_SEC)

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
