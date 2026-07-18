// LLM ad detection over an episode's transcript, as a background job (download-jobs
// type 'podcast-ad-scan', compute lane). The scan reads the verbatim timestamped
// transcript in overlapping windows, asks the model for ad ranges, and lands merged,
// sanity-checked segments in podcast_ad_scans. Playback never cuts audio; the player
// seeks past the stored ranges client-side, so a wrong detection is always reversible
// (podcast_ad_reports 'not_ad' rows suppress ranges at serve time).

import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs, podcastAdReports, podcastAdScans, podcastEpisodes, podcastShowSettings, podcastShowSponsors, podcastTranscripts, userPreferences } from '@/db/schema'
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

// Per-LINE classification, not boundary detection. Local models are weak at "where does
// the topic change back to the show" and at spotting salesy speech that reads like normal
// talk ("it comes in four delicious flavors", "switch to Allstate and save"). So we do not
// ask for boundaries at all: we ask the model to label each numbered line as advertising
// or not, one line at a time, and the ad ranges fall out of the contiguous ad lines. The
// times come from those segments (never model-computed seconds). Few-shot examples anchor
// the salesy register the model otherwise misses.
const AD_LINES_SYSTEM =
  'You label the advertising lines in a podcast transcript. Every line begins with its line number in square ' +
  'brackets, like [42]. Judge each line ON ITS OWN. ' +
  'A line is ADVERTISING if it is any part of a sponsor read, commercial, promo, jingle, discount or promo-code ' +
  'read, or a call to action for a product or service. This INCLUDES product descriptions and slogans even when ' +
  'they sound conversational. Examples of advertising lines:\n' +
  '  "This episode is brought to you by Acme."\n' +
  '  "And it comes in four delicious flavors."\n' +
  '  "Switch to Allstate and you could save hundreds."\n' +
  '  "Use code POD for twenty percent off your first order."\n' +
  '  "Just head to example dot com slash pod."\n' +
  '  "Terms and conditions apply."\n' +
  'A line is NOT advertising if it is the hosts\' own conversation, the episode\'s topic, banter, interviewing a ' +
  'guest, or the intro and sign-off. Examples of NOT advertising:\n' +
  '  "So what did you actually think of the movie?"\n' +
  '  "I cannot believe he said that on air."\n' +
  '  "Our guest today needs no introduction."\n' +
  'Return JSON {"adLines": [the line numbers, copied exactly from the brackets, that are advertising]}. Return ' +
  '{"adLines": []} if none. Do not use em dashes.'

// A single non-ad line inside an ad (a quick host aside) shouldn't split one ad in two:
// bridge gaps up to this many lines between ad-labeled lines.
const AD_LINE_GAP = 2

interface AdLinesResponse { adLines?: unknown }

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

/** Collect the ad-labeled line numbers the model returned for one window, keeping only
 *  valid indices inside the window (anything outside is a hallucination). */
function collectAdLines(raw: unknown, windowStart: number, windowEnd: number, into: Set<number>): void {
  if (!Array.isArray(raw)) return
  for (const v of raw) {
    // Tolerate "[105]" / "105" as well as a bare number.
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10)
    const i = Math.round(n)
    if (Number.isFinite(i) && i >= windowStart && i <= windowEnd) into.add(i)
  }
}

/** Turn the set of ad-labeled line indices into time ranges: bridge tiny gaps, take
 *  contiguous runs, map to the segments' own start/end times, and drop implausibly
 *  short/long runs. */
function adLinesToRanges(adSet: Set<number>, segments: TranscriptSegment[]): RawRange[] {
  if (!adSet.size) return []
  const flag = new Uint8Array(segments.length)
  for (const i of adSet) if (i >= 0 && i < segments.length) flag[i] = 1
  // Bridge single-line (up to AD_LINE_GAP) non-ad gaps so a brief aside doesn't split one ad.
  let i = 0
  while (i < flag.length) {
    if (flag[i]) { i++; continue }
    let j = i
    while (j < flag.length && !flag[j]) j++
    if (i > 0 && j < flag.length && j - i <= AD_LINE_GAP) for (let k = i; k < j; k++) flag[k] = 1
    i = j
  }
  const out: RawRange[] = []
  i = 0
  while (i < flag.length) {
    if (!flag[i]) { i++; continue }
    let j = i
    while (j < flag.length && flag[j]) j++
    const first = segments[i]!, last = segments[j - 1]!
    const len = last.endSec - first.startSec
    if (len >= MIN_AD_SEC && len <= MAX_AD_SEC) {
      out.push({ startSec: Math.max(0, first.startSec), endSec: last.endSec, kind: 'ad', confidence: 0.8 })
    }
    i = j
  }
  return out
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

// ── Cross-episode sponsor memory ────────────────────────────────────────────────────
// Lines of read to include around a known-sponsor mention (the brand appears once, but
// the whole read is the ad).
const SPONSOR_REACH_LINES = 8
// Never store these as "sponsors" (generic ad-speak, not a brand).
const GENERIC_SPONSOR = new Set(['the show', 'this show', 'this podcast', 'the podcast', 'our sponsor', 'our sponsors',
  'this episode', 'the episode', 'sponsor', 'sponsors', 'advertisement', 'promo code', 'the company', 'the brand'])

const SPONSOR_EXTRACT_SYSTEM =
  'You are given excerpts of podcast ADVERTISING copy. List the distinct brands, products, or companies being ' +
  'advertised. Return JSON {"sponsors": [array of short brand names as strings]}. Use the brand name only ' +
  '(for example "Apple Card", "BetterHelp", "ZipRecruiter"), never a description or sentence. Return ' +
  '{"sponsors": []} if none are clear. Do not use em dashes.'

/** Brands this show is known to advertise (lowercased phrases), for the deterministic
 *  recurring-ad pass. */
async function loadShowSponsors(showId: string | null): Promise<string[]> {
  if (!showId) return []
  const rows = await db.select({ name: podcastShowSponsors.name }).from(podcastShowSponsors)
    .where(eq(podcastShowSponsors.showId, showId)).limit(200).catch(() => [])
  return rows.map(r => r.name).filter(n => n.length >= 4)
}

/** Flag lines that mention a known sponsor of this show, plus the surrounding read. This
 *  is MinusPod's cross-episode catch: a recurring sponsor is found without the LLM. */
function flagKnownSponsorLines(segments: TranscriptSegment[], sponsors: string[], into: Set<number>): number {
  if (!sponsors.length) return 0
  let hits = 0
  for (let i = 0; i < segments.length; i++) {
    const text = segments[i]!.text.toLowerCase()
    if (!sponsors.some(s => text.includes(s))) continue
    hits++
    for (let k = Math.max(0, i - SPONSOR_REACH_LINES); k <= Math.min(segments.length - 1, i + SPONSOR_REACH_LINES); k++) into.add(k)
  }
  return hits
}

/** Learn the brands advertised in this episode's ads, so future episodes catch them for
 *  free. Best-effort (one small LLM call). */
async function extractAndStoreSponsors(showId: string | null, adText: string, model: string): Promise<void> {
  if (!showId || adText.trim().length < 20) return
  try {
    const res = await structuredCall<{ sponsors?: unknown }>(
      model, `Advertising excerpts:\n${adText.slice(0, 8000)}`, SPONSOR_EXTRACT_SYSTEM, { num_predict: 200 }, 'json')
    const names = new Set((Array.isArray(res.sponsors) ? res.sponsors : [])
      .map(s => String(s).toLowerCase().replace(/[^\w &'-]/g, '').replace(/\s+/g, ' ').trim())
      .filter(s => s.length >= 4 && s.length <= 60 && !GENERIC_SPONSOR.has(s)))
    const now = new Date()
    for (const name of names) {
      await db.insert(podcastShowSponsors)
        .values({ id: crypto.randomUUID(), showId, name, hits: 1, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [podcastShowSponsors.showId, podcastShowSponsors.name], set: { hits: sql`${podcastShowSponsors.hits} + 1`, updatedAt: now } })
        .catch(() => {})
    }
    if (names.size) logger.info(`[podcast-ad-scan] learned ${names.size} sponsor(s) for show ${showId}`)
  } catch { /* best-effort */ }
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

    // ── Cross-episode memory: flag lines mentioning a known sponsor of this show ───
    const adLines = new Set<number>()
    const knownSponsors = await loadShowSponsors(episode.showId)
    const sponsorHits = flagKnownSponsorLines(segs, knownSponsors, adLines)
    if (sponsorHits) logger.info(`[podcast-ad-scan] ${sponsorHits} known-sponsor mention(s) pre-flagged`)

    // ── Per-line ad classification over each window ────────────────────────────────
    // The boundaries fall out of the contiguous ad-labeled lines, so the model never has
    // to judge where a topic changes (which it is bad at) - only "is THIS line an ad".
    let failedWindows = 0
    for (let w = 0; w < windows.length; w++) {
      if (signal.aborted) throw new Error('Aborted')
      const win = windows[w]!
      onProgress({ completed: w, total: windows.length, speedBps: 0, etaSeconds: 0, note: `Scanning for ads ${Math.round((w / windows.length) * 100)}%` })
      const prompt = [
        `Episode title: ${episode.title}`,
        `This excerpt is part of a [${total}] episode. Each transcript line begins with its line number in [brackets].`,
        '',
        'Transcript:',
        win.text,
      ].join('\n')
      // format 'json' forces valid JSON; num_predict roomy for a window full of ad lines.
      // A single window that fails does not sink the episode.
      try {
        const res = await structuredCall<AdLinesResponse>(model, prompt, AD_LINES_SYSTEM, { num_predict: 1500 }, 'json')
        collectAdLines(res.adLines, win.startIdx, win.endIdx, adLines)
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
    ranges.push(...adLinesToRanges(adLines, segs))

    // Union the deterministic keyword pass so ads the model missed still get caught (the
    // merge below dedupes overlap).
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

    // Learn this episode's sponsors so future episodes of the show catch them for free.
    if (segments.length) {
      const adText = segments
        .map(seg => segs.filter(s => s.endSec > seg.startSec && s.startSec < seg.endSec).map(s => s.text).join(' '))
        .join('\n\n')
      await extractAndStoreSponsors(episode.showId, adText, model)
    }
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
