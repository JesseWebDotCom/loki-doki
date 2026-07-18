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
// Detection guards: implausibly short and long ranges are dropped; nearby ranges merge
// (adjacent ads in one break pod become a single skippable block); total capped.
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

export const adScanJobRefId = (episodeId: string) =>
  JSON.stringify({ episodeId } satisfies PodcastAdScanPayload)

// ANCHOR-AND-GROW detection.
// The model is never asked to find boundaries or to label a whole window (it is bad at
// both). Instead:
//   1. ANCHOR: collect lines that are OBVIOUSLY ads, from high-precision sources - the
//      keyword regex, known sponsors of this show, the user's missed-ad reports, and an
//      LLM pass that is told to mark only lines it is certain about.
//   2. GROW: cluster the anchors, then for each cluster repeatedly show the model the ad
//      text plus the few sentences just before (or after) it and ask the one easy
//      question: are these part of the SAME ad? Extend through the contiguous "yes"
//      lines; stop at the first "no". A few small, focused judgments instead of one
//      giant labeling task, and the growth knows what ad it is following.
const AD_ANCHOR_SYSTEM =
  'You find lines that are OBVIOUSLY advertising in a podcast transcript. Every line begins with its line number ' +
  'in square brackets, like [42]. Return JSON {"adLines": [line numbers copied exactly from the brackets]}. ' +
  'Mark ONLY lines you are certain are advertising: a sponsorship announcement ("this episode is brought to you ' +
  'by ..."), a promo or discount code, a spoken URL ("acme dot com slash pod"), an offer or savings pitch ' +
  '("switch to Allstate and you could save hundreds", "get twenty percent off"), a product slogan or feature ' +
  'pitch ("it comes in four delicious flavors"), or a call to action to buy, subscribe, or sign up. ' +
  'Do NOT mark the hosts\' own conversation, banter, or the episode topic, and skip borderline lines entirely: ' +
  'the sentences around your marks are examined separately, so only certain lines matter. ' +
  'Return {"adLines": []} if none. Do not use em dashes.'

const AD_GROW_SYSTEM =
  'You are shown part of an ADVERTISEMENT from a podcast, then the numbered sentences that come immediately ' +
  'before or after it in the transcript. Decide which of those sentences are part of the SAME advertisement: the ' +
  'same sponsor or product, its lead-in ("we will be right back", "this episode is brought to you by"), more of ' +
  'the pitch or the offer, the promo code or URL, the legal terms, or the hand-off back to the show. Sentences ' +
  'where the hosts are having their own conversation or discussing the episode topic are NOT part of the ad. ' +
  'Return JSON {"related": [the line numbers, copied exactly from the brackets, that are part of the same ad]}. ' +
  'Return {"related": []} if none are. Do not use em dashes.'

// Anchors within this many lines of each other belong to the same ad cluster.
const ANCHOR_CLUSTER_GAP = 6
// Growth: sentences examined per step, and max steps per direction. 8 lines x 6 rounds
// reaches ~48 lines each way, far past any real ad, while each call stays tiny.
const GROW_BATCH = 8
const GROW_ROUNDS = 6
// Ads cluster at the episode's open (pre-roll) and close (post-roll); those zones get an
// extra anchor pass with a prompt that expects an ad there.
const EDGE_ZONE_SEC = 180

interface AdLinesResponse { adLines?: unknown }

// Verification pass (MinusPod): re-check the candidate ads and drop clear non-ads. Kept
// conservative (only removes what the model is confident is NOT an ad) so it improves
// precision without eating real ads.
const AD_VERIFY_SYSTEM =
  'You are given numbered candidate advertising excerpts from a podcast. For each, decide whether it is genuinely ' +
  'an advertisement (a sponsor read, commercial, or promo) rather than the hosts\' own conversation or the ' +
  'episode topic. Return JSON {"notAds": [the numbers of any excerpt that is NOT an advertisement]}. Return ' +
  '{"notAds": []} if they are all ads. Only list an excerpt as not an ad when you are confident. Do not use em dashes.'

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

/** Group anchor lines into clusters: anchors within ANCHOR_CLUSTER_GAP lines belong to
 *  the same ad. Each cluster is grown to the full ad afterwards. */
function clusterAnchors(anchors: Set<number>, maxIdx: number): { lo: number; hi: number }[] {
  const sorted = [...anchors].filter(i => i >= 0 && i <= maxIdx).sort((a, b) => a - b)
  const out: { lo: number; hi: number }[] = []
  for (const i of sorted) {
    const prev = out[out.length - 1]
    if (prev && i - prev.hi <= ANCHOR_CLUSTER_GAP) prev.hi = i
    else out.push({ lo: i, hi: i })
  }
  return out.slice(0, MAX_SEGMENTS)
}

/** Grow one anchor cluster to the full ad. Each step shows the model the ad text plus the
 *  GROW_BATCH sentences adjacent to the current boundary and asks which are part of the
 *  SAME ad; the boundary extends through the contiguous "yes" run and stops at the first
 *  "no" (or when a step grows nothing, or the length cap is hit). */
async function growCluster(
  cluster: { lo: number; hi: number },
  segs: TranscriptSegment[],
  model: string,
  signal: AbortSignal,
): Promise<{ lo: number; hi: number }> {
  let { lo, hi } = cluster
  // The ad identity shown to the model: the first ~12 anchor-cluster lines.
  const adPreview = segs.slice(lo, Math.min(hi + 1, lo + 12)).map(s => s.text).join(' ').slice(0, 700)

  const step = async (dir: 'before' | 'after'): Promise<boolean> => {
    const batchLo = dir === 'before' ? Math.max(0, lo - GROW_BATCH) : hi + 1
    const batchHi = dir === 'before' ? lo - 1 : Math.min(segs.length - 1, hi + GROW_BATCH)
    if (batchHi < batchLo) return false
    const lines: string[] = []
    for (let i = batchLo; i <= batchHi; i++) lines.push(`[${i}] ${segs[i]!.text}`)
    const prompt = [
      `Advertisement text:\n"${adPreview}"`,
      '',
      `Numbered sentences immediately ${dir.toUpperCase()} the advertisement:`,
      lines.join('\n'),
      '',
      'Which of these numbered sentences are part of the same advertisement?',
    ].join('\n')
    const res = await structuredCall<{ related?: unknown }>(model, prompt, AD_GROW_SYSTEM, { num_predict: 100 }, 'json')
    const related = new Set<number>()
    collectAdLines(res.related, batchLo, batchHi, related)
    // Extend only through the contiguous run touching the boundary; a detached "yes"
    // farther out is a different ad or a mistake.
    let grew = false
    if (dir === 'before') {
      let newLo = lo
      for (let i = lo - 1; i >= batchLo; i--) { if (related.has(i)) newLo = i; else break }
      if (newLo < lo && segs[hi]!.endSec - segs[newLo]!.startSec <= MAX_AD_SEC) { grew = newLo === batchLo; lo = newLo }
    } else {
      let newHi = hi
      for (let i = hi + 1; i <= batchHi; i++) { if (related.has(i)) newHi = i; else break }
      if (newHi > hi && segs[newHi]!.endSec - segs[lo]!.startSec <= MAX_AD_SEC) { grew = newHi === batchHi; hi = newHi }
    }
    // Continue another round only when the growth consumed the whole batch (the boundary
    // may still be farther out); a partial extension means the edge was found.
    return grew
  }

  for (let r = 0; r < GROW_ROUNDS; r++) {
    if (signal.aborted) throw new Error('Aborted')
    let more = false
    try { more = await step('before') } catch { break }
    if (!more) break
  }
  for (let r = 0; r < GROW_ROUNDS; r++) {
    if (signal.aborted) throw new Error('Aborted')
    let more = false
    try { more = await step('after') } catch { break }
    if (!more) break
  }
  return { lo, hi }
}

// ── Cross-episode sponsor memory ────────────────────────────────────────────────────
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

/** Anchor lines that mention a known sponsor of this show. This is MinusPod's
 *  cross-episode catch: a recurring sponsor is anchored without the LLM, and the growth
 *  pass finds the read's full extent. */
function flagKnownSponsorLines(segments: TranscriptSegment[], sponsors: string[], into: Set<number>): number {
  if (!sponsors.length) return 0
  let hits = 0
  for (let i = 0; i < segments.length; i++) {
    const text = segments[i]!.text.toLowerCase()
    if (!sponsors.some(s => text.includes(s))) continue
    hits++
    into.add(i)
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

/** Positional prior: anchor-scan just the opening or closing zone with a prompt that
 *  expects an ad there. Catches pre/post-rolls the general anchor pass missed. */
async function anchorEdgeZone(segments: TranscriptSegment[], zone: 'opening' | 'closing', model: string, into: Set<number>): Promise<void> {
  const total = segments[segments.length - 1]!.endSec
  const idxs: number[] = []
  for (let i = 0; i < segments.length; i++) {
    const inZone = zone === 'opening' ? segments[i]!.startSec <= EDGE_ZONE_SEC : segments[i]!.startSec >= total - EDGE_ZONE_SEC
    if (inZone) idxs.push(i)
  }
  if (idxs.length < 2) return
  const text = idxs.map(i => `[${i}] ${segments[i]!.text}`).join('\n')
  const note = zone === 'opening'
    ? 'This is the OPENING of the episode. Podcasts almost always begin with an advertisement (a pre-roll) before the hosts start the show.'
    : 'This is the END of the episode, which often contains an advertisement (a post-roll).'
  try {
    const res = await structuredCall<AdLinesResponse>(model, `${note}\n\nTranscript:\n${text}`, AD_ANCHOR_SYSTEM, { num_predict: 400 }, 'json')
    collectAdLines(res.adLines, idxs[0]!, idxs[idxs.length - 1]!, into)
  } catch { /* best-effort */ }
}

/** Verification pass: one call over all candidate ranges, drop those the model is
 *  confident are not ads. Failure keeps everything (recall-safe). */
async function verifyRanges(ranges: RawRange[], segments: TranscriptSegment[], model: string): Promise<RawRange[]> {
  if (ranges.length < 1) return ranges
  const excerpts = ranges.map((r, i) => {
    const t = segments.filter(s => s.endSec > r.startSec && s.startSec < r.endSec).map(s => s.text).join(' ').slice(0, 600)
    return `[${i}] ${t}`
  }).join('\n\n')
  try {
    const res = await structuredCall<{ notAds?: unknown }>(model, `Candidate ads:\n${excerpts}`, AD_VERIFY_SYSTEM, { num_predict: 100 }, 'json')
    const reject = new Set((Array.isArray(res.notAds) ? res.notAds : []).map(v => Math.round(Number(v))).filter(n => Number.isFinite(n)))
    if (!reject.size) return ranges
    return ranges.filter((_, i) => !reject.has(i))
  } catch {
    return ranges
  }
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

    // ── ANCHOR: collect obviously-ad lines from every high-precision source ─────────
    const anchors = new Set<number>()

    // Deterministic keyword hits (promo codes, "brought to you by", spoken URLs, ...).
    for (let i = 0; i < segs.length; i++) if (AD_SIGNAL.test(segs[i]!.text)) anchors.add(i)

    // Known sponsors of this show (cross-episode memory).
    const knownSponsors = await loadShowSponsors(episode.showId)
    const sponsorHits = flagKnownSponsorLines(segs, knownSponsors, anchors)
    if (sponsorHits) logger.info(`[podcast-ad-scan] ${sponsorHits} known-sponsor anchor(s)`)

    // The user's "missed ad" reports anchor their reported position.
    const missed = await db.select({ startSec: podcastAdReports.startSec }).from(podcastAdReports)
      .where(and(eq(podcastAdReports.episodeId, episodeId), eq(podcastAdReports.kind, 'missed'))).catch(() => [])
    for (const m of missed) {
      let idx = segs.findIndex(s => s.endSec >= m.startSec)
      if (idx < 0) idx = segs.length - 1
      anchors.add(idx)
    }

    // LLM anchor pass over each window: only lines it is CERTAIN are ads.
    let failedWindows = 0
    for (let w = 0; w < windows.length; w++) {
      if (signal.aborted) throw new Error('Aborted')
      const win = windows[w]!
      onProgress({ completed: w, total: windows.length, speedBps: 0, etaSeconds: 0, note: `Finding ads ${Math.round((w / windows.length) * 70)}%` })
      const prompt = [
        `Episode title: ${episode.title}`,
        `This excerpt is part of a [${total}] episode. Each transcript line begins with its line number in [brackets].`,
        '',
        'Transcript:',
        win.text,
      ].join('\n')
      try {
        const res = await structuredCall<AdLinesResponse>(model, prompt, AD_ANCHOR_SYSTEM, { num_predict: 800 }, 'json')
        collectAdLines(res.adLines, win.startIdx, win.endIdx, anchors)
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

    // Positional prior: extra anchor pass over the open and close, where ads cluster.
    await anchorEdgeZone(segs, 'opening', model, anchors)
    await anchorEdgeZone(segs, 'closing', model, anchors)

    // ── GROW: expand each anchor cluster to the full ad, a few sentences at a time ──
    const clusters = clusterAnchors(anchors, segs.length - 1)
    logger.info(`[podcast-ad-scan] ${anchors.size} anchor(s) -> ${clusters.length} cluster(s)`)
    for (let ci = 0; ci < clusters.length; ci++) {
      if (signal.aborted) throw new Error('Aborted')
      onProgress({ completed: windows.length, total: windows.length, speedBps: 0, etaSeconds: 0, note: `Expanding ad ${ci + 1}/${clusters.length}` })
      const grown = await growCluster(clusters[ci]!, segs, model, signal)
      const first = segs[grown.lo]!, last = segs[grown.hi]!
      if (last.endSec - first.startSec >= MIN_AD_SEC) {
        ranges.push({ startSec: Math.max(0, first.startSec), endSec: last.endSec, kind: 'ad', confidence: 0.85 })
      }
    }

    // NOTE: the audio two-fetch fingerprint diff (adFingerprint.ts) stays DISABLED (this
    // show re-encodes each fetch, so the diff flags everything).

    // Times already come straight from transcript segment boundaries (no model-computed
    // seconds), so no snapping is needed; just drop anything too short after the merge.
    const snapped = ranges.filter(r => r.endSec - r.startSec >= MIN_AD_SEC)
    let merged = mergeRanges(snapped)

    // Verification pass (precision): drop candidates the model is confident are not ads.
    if (merged.length) {
      onProgress({ completed: windows.length, total: windows.length, speedBps: 0, etaSeconds: 0, note: 'Verifying ads' })
      merged = await verifyRanges(merged, segs, model)
    }

    const segments: AdSegment[] = merged.map(r => ({ id: crypto.randomUUID(), ...r }))

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
