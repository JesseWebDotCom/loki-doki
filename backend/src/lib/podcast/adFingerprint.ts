// Audio-based ad detection for dynamically-inserted ads — the method text/LLM detection
// cannot catch (a slick brand ad has no promo code or keyword). Two signals:
//
//  1. Two-fetch diff (primary). Dynamic ad insertion stitches DIFFERENT ads into each
//     fetch of the same episode, while the show content is identical. So we fingerprint
//     the downloaded copy (what you play) and a second fresh fetch, and any stretch of
//     the played copy whose audio does NOT appear in the second copy is an inserted ad.
//     Content-agnostic: it flags the ad because the bytes differ, not because it "sounds
//     like" an ad. (US patent 10,504,135 describes this exact comparison.)
//
//  2. Known-ad memory (ChromaPrint-style "learn from every episode"). Fingerprints of
//     confirmed ads are stored per show; a new episode is matched against them so a
//     recurring sponsor read is caught on the first pass without a second fetch.
//
// Fingerprint: the Philips/Haitsma-Kalker robust hash — 32 bits per frame from the sign
// of sub-band energy differences over 33 bark-scaled bands in 300-2000 Hz. Robust to
// bitrate, volume, and re-encoding, which is what lets identical content match across two
// independently-stitched fetches. All of this is best-effort: any failure returns no
// ranges and the transcript-based methods still stand.

import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets, podcastAdFingerprints, podcastEpisodes } from '@/db/schema'
import { acquireRead, blobAbsPath, contentTmpDir, releaseRead } from '@/lib/content/store'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { safeFetch } from '@/lib/ssrfGuard'
import { logger } from '@/lib/logger'

export interface AudioAdRange { startSec: number; endSec: number; kind: 'sponsor' | 'ad' | 'promo'; confidence: number }

// ── Signal / hashing parameters ────────────────────────────────────────────────────
const SR = 11025            // decode rate; 300-2000 Hz band fits well below Nyquist
const FRAME = 2048          // ~0.186 s FFT window per fingerprint frame
// A dense, overlapping hop is essential: an inserted ad shifts the shared content by an
// arbitrary sub-frame amount between the two fetches, so only a fine grid guarantees a
// near-aligned frame exists on both sides to match. Validated against synthetic
// misaligned content: content matches tightly (median 0 bit-errors), ads stay separated.
const HOP = 256             // ~0.023 s time resolution
const BAND_LO = 300
const BAND_HI = 2000
const N_BANDS = 33          // -> 32 fingerprint bits from consecutive band differences
const SEC_PER_FRAME = HOP / SR
// A frame of A "matches" B when some B frame is within this many bits (out of 32). Tight,
// because dense identical content matches near-exactly; ads sit well above it.
const MATCH_BITS = 2
const MIN_AD_SEC = 8
const MAX_AD_SEC = 600
// An ad is a region where the fraction of unmatched frames over this window exceeds the
// threshold. Density (not contiguity) is what separates a real ad break (~0.5-0.65
// unmatched in tests) from the sparse false-mismatches scattered through content (~0.03).
const DENSITY_WIN_SEC = 2.0
const DENSITY_THRESH = 0.30
// Memory matching (a stored ad vs a new episode) tolerates more jitter than the diff,
// since the stored ad came from a different fetch/episode.
const MEM_MATCH_BITS = 4
// Bound the memory match so a big library can't make a scan crawl.
const MAX_KNOWN_ADS = 300
// Yield to the event loop every this many FFT frames so the (100k+ frame) fingerprint
// pass never blocks the server.
const YIELD_EVERY = 512

function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >>> 24
}

// In-place iterative radix-2 FFT (N a power of two).
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const tr = re[i]!; re[i] = re[j]!; re[j] = tr; const ti = im[i]!; im[i] = im[j]!; im[j] = ti }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!, ui = im[i + k]!
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr
        re[i + k] = ur + vr; im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr
      }
    }
  }
}

// Precompute the FFT-bin range of each of the 33 bark-ish (log-spaced) bands, and a Hann
// window, once per process.
const BAND_BINS: Array<[number, number]> = (() => {
  const edges: number[] = []
  for (let i = 0; i <= N_BANDS; i++) edges.push(BAND_LO * Math.pow(BAND_HI / BAND_LO, i / N_BANDS))
  const binOf = (hz: number) => Math.min(FRAME / 2 - 1, Math.max(0, Math.round((hz * FRAME) / SR)))
  const bins: Array<[number, number]> = []
  for (let m = 0; m < N_BANDS; m++) bins.push([binOf(edges[m]!), Math.max(binOf(edges[m]!) + 1, binOf(edges[m + 1]!))])
  return bins
})()
const HANN = (() => { const w = new Float64Array(FRAME); for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)); return w })()

/** Haitsma-Kalker sub-fingerprints for a mono signal: one 32-bit hash per HOP frames.
 *  Async and cooperative: yields to the event loop periodically so a long episode's tens
 *  of thousands of FFTs never freeze the server. */
async function fingerprint(samples: Float32Array, signal: AbortSignal): Promise<Uint32Array> {
  const nFrames = samples.length >= FRAME ? 1 + Math.floor((samples.length - FRAME) / HOP) : 0
  if (nFrames <= 1) return new Uint32Array(0)
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME)
  const bandE = new Float64Array(N_BANDS)
  let prevBandE: Float64Array | null = null
  const out = new Uint32Array(nFrames)          // frame 0 has no previous frame -> stays 0
  for (let f = 0; f < nFrames; f++) {
    if ((f % YIELD_EVERY) === 0) {
      if (signal.aborted) throw new Error('Aborted')
      await new Promise<void>(r => setTimeout(r, 0))
    }
    const base = f * HOP
    for (let i = 0; i < FRAME; i++) { re[i] = samples[base + i]! * HANN[i]!; im[i] = 0 }
    fft(re, im)
    for (let m = 0; m < N_BANDS; m++) {
      let e = 0
      for (let b = BAND_BINS[m]![0]; b < BAND_BINS[m]![1]; b++) e += re[b]! * re[b]! + im[b]! * im[b]!
      bandE[m] = e
    }
    if (prevBandE) {
      let h = 0
      for (let m = 0; m < 32; m++) {
        const d = (bandE[m]! - bandE[m + 1]!) - (prevBandE[m]! - prevBandE[m + 1]!)
        if (d > 0) h |= (1 << m)
      }
      out[f] = h >>> 0
    }
    if (!prevBandE) prevBandE = new Float64Array(N_BANDS)
    prevBandE.set(bandE)
  }
  return out
}

/** Decode any audio file to mono Float32 at SR via ffmpeg. */
async function decodePcm(ffmpeg: string, path: string, signal: AbortSignal): Promise<Float32Array> {
  const proc = Bun.spawn([ffmpeg, '-v', 'error', '-nostdin', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'],
    { stdout: 'pipe', stderr: 'pipe' })
  const onAbort = () => proc.kill()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const [buf, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited])
    if (code !== 0) throw new Error(`ffmpeg pcm decode failed (${code})`)
    const i16 = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2))
    const out = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) out[i] = i16[i]! / 32768
    return out
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Read-pinned local path of the episode's downloaded copy (what the player uses). */
async function resolveCanonicalPath(assetId: string | null): Promise<{ path: string; cleanup: () => void } | null> {
  if (!assetId) return null
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  if (asset?.status !== 'ready' || !asset.blobHash) return null
  const path = await blobAbsPath(asset.blobHash)
  acquireRead(asset.blobHash)
  return { path, cleanup: () => releaseRead(asset.blobHash!) }
}

/** Fetch a second copy of the enclosure to a temp file (a fresh request usually gets a
 *  different dynamic-ad stitch). Cache-busted to discourage a CDN edge cache from
 *  returning the identical response. */
async function fetchSecondCopy(episodeId: string, enclosureUrl: string, signal: AbortSignal): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  const bust = enclosureUrl + (enclosureUrl.includes('?') ? '&' : '?') + `_ld=${episodeId.slice(0, 8)}`
  const res = await safeFetch(bust, {
    headers: { 'User-Agent': 'MaiPaiHome/3.0 podcast adcheck', Accept: '*/*', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
  }, { timeoutMs: 60_000, maxRedirects: 8 }).catch(() => null)
  if (!res?.ok || !res.body) { res?.body?.cancel().catch(() => {}); return null }
  const tmpPath = join(await contentTmpDir(), `podcast-adcheck-${episodeId}-b`)
  const out = createWriteStream(tmpPath)
  const reader = res.body.getReader()
  try {
    for (;;) {
      if (signal.aborted) throw new Error('Aborted')
      const { done, value } = await reader.read()
      if (done) break
      await new Promise<void>((resolve, reject) => out.write(value, err => err ? reject(err) : resolve()))
    }
  } catch (err) {
    await new Promise<void>(resolve => out.end(() => resolve()))
    await unlink(tmpPath).catch(() => {})
    throw err
  } finally {
    reader.releaseLock?.()
  }
  await new Promise<void>(resolve => out.end(() => resolve()))
  return { path: tmpPath, cleanup: async () => { await unlink(tmpPath).catch(() => {}) } }
}

/** Turn a per-frame unmatched mask into ad ranges by local DENSITY: a frame belongs to an
 *  ad when the fraction of unmatched frames in a window around it clears the threshold.
 *  Density (not run-length) is what cleanly separates a real break from the sparse
 *  false-mismatches that dust ordinary content, which hole-filling would wrongly bridge. */
function densityRanges(isAd: Uint8Array): AudioAdRange[] {
  const n = isAd.length
  const W = Math.round(DENSITY_WIN_SEC / SEC_PER_FRAME)
  const pre = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i]! + isAd[i]!
  const ad = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(n, i + W + 1)
    ad[i] = (pre[hi]! - pre[lo]!) / (hi - lo) >= DENSITY_THRESH ? 1 : 0
  }
  const ranges: AudioAdRange[] = []
  let i = 0
  while (i < n) {
    if (!ad[i]) { i++; continue }
    let j = i
    while (j < n && ad[j]) j++
    const startSec = i * SEC_PER_FRAME, endSec = j * SEC_PER_FRAME
    const len = endSec - startSec
    if (len >= MIN_AD_SEC && len <= MAX_AD_SEC) ranges.push({ startSec, endSec, kind: 'ad', confidence: 0.9 })
    i = j
  }
  return ranges
}

const LSH_BANDS = 3          // 2-bit-error tolerance: 3 bands => at least one exact by pigeonhole
const LSH_BAND_BITS = 11

/** For each frame of A, is its audio absent from B (i.e. an inserted ad)? Exact-hash hit
 *  first (frame-aligned content), else an LSH-banded fuzzy lookup: any B frame within
 *  MATCH_BITS of it counts as the same audio at a slightly shifted position. LSH keeps
 *  this near O(n) instead of O(n*m). */
function diffMask(a: Uint32Array, b: Uint32Array): Uint8Array {
  const bUniq: number[] = [...new Set(b)].filter(h => h !== 0)
  const bSet = new Set<number>(bUniq)
  const bandKey = (h: number, k: number) => (h >>> (k * LSH_BAND_BITS)) & ((1 << LSH_BAND_BITS) - 1)
  const buckets: Array<Map<number, number[]>> = Array.from({ length: LSH_BANDS }, () => new Map())
  for (const h of bUniq) {
    for (let k = 0; k < LSH_BANDS; k++) {
      const key = bandKey(h, k)
      let arr = buckets[k]!.get(key)
      if (!arr) { arr = []; buckets[k]!.set(key, arr) }
      arr.push(h)
    }
  }
  const isAd = new Uint8Array(a.length)
  const seen = new Set<number>()
  for (let i = 0; i < a.length; i++) {
    const h = a[i]!
    if (h === 0 || bSet.has(h)) continue          // frame-0 sentinel / exact content match
    let matched = false
    seen.clear()
    for (let k = 0; k < LSH_BANDS && !matched; k++) {
      const arr = buckets[k]!.get(bandKey(h, k))
      if (!arr) continue
      for (const c of arr) {
        if (seen.has(c)) continue
        seen.add(c)
        if (popcount32(h ^ c) <= MATCH_BITS) { matched = true; break }
      }
    }
    if (!matched) isAd[i] = 1
  }
  return isAd
}

/** Primary method: fingerprint the downloaded copy + a fresh fetch, mark the parts of the
 *  downloaded copy whose audio is not in the fresh fetch. Returns [] on any problem, and
 *  also returns the played copy's fingerprints so the caller can remember confirmed ads. */
export async function detectDaiAdsByDiff(
  episode: { id: string; assetId: string | null; enclosureUrl: string | null; showId: string | null },
  signal: AbortSignal,
  onNote?: (note: string) => void,
): Promise<{ ranges: AudioAdRange[]; canonicalFp: Uint32Array | null }> {
  if (!episode.enclosureUrl) return { ranges: [], canonicalFp: null }
  const canonical = await resolveCanonicalPath(episode.assetId)
  if (!canonical) return { ranges: [], canonicalFp: null }
  let second: Awaited<ReturnType<typeof fetchSecondCopy>> = null
  try {
    const ffmpeg = await ensureFfmpeg()
    onNote?.('Fingerprinting audio')
    const aFp = await fingerprint(await decodePcm(ffmpeg, canonical.path, signal), signal)
    if (!aFp.length) return { ranges: [], canonicalFp: null }
    onNote?.('Fetching a second copy')
    second = await fetchSecondCopy(episode.id, episode.enclosureUrl, signal)
    if (!second) return { ranges: [], canonicalFp: aFp }        // no B: memory can still use aFp
    const bFp = await fingerprint(await decodePcm(ffmpeg, second.path, signal), signal)
    if (!bFp.length) return { ranges: [], canonicalFp: aFp }
    onNote?.('Comparing copies')
    const mask = diffMask(aFp, bFp)
    let flagged = 0; for (let i = 0; i < mask.length; i++) flagged += mask[i]!
    const ranges = densityRanges(mask)
    logger.info(`[podcast-ad-fp] "${episode.id}": ${(100 * flagged / mask.length).toFixed(0)}% frames differ -> ${ranges.length} ad range(s)`)
    return { ranges, canonicalFp: aFp }
  } catch (err) {
    logger.warn(`[podcast-ad-fp] diff failed for ${episode.id}: ${String(err).slice(0, 160)}`)
    return { ranges: [], canonicalFp: null }
  } finally {
    canonical.cleanup()
    if (second) await second.cleanup()
  }
}

// ── Known-ad memory (learn once, recognize everywhere) ──────────────────────────────

function packFp(fp: Uint32Array): Buffer { return Buffer.from(fp.buffer, fp.byteOffset, fp.byteLength) }
// Copy into a fresh, 4-byte-aligned buffer: a SQLite blob view is not guaranteed aligned
// for a Uint32Array, which would throw.
function unpackFp(raw: unknown): Uint32Array {
  const bytes = raw instanceof Uint8Array ? raw : Buffer.from(raw as ArrayBuffer)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Uint32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
}

/** Remember the fingerprint of each confirmed ad range so it can be recognized in future
 *  episodes of the show without a second fetch. */
export async function rememberAds(showId: string | null, ranges: AudioAdRange[], canonicalFp: Uint32Array): Promise<void> {
  if (!showId || !ranges.length || !canonicalFp.length) return
  const now = new Date()
  for (const r of ranges) {
    const lo = Math.max(0, Math.floor(r.startSec / SEC_PER_FRAME))
    const hi = Math.min(canonicalFp.length, Math.ceil(r.endSec / SEC_PER_FRAME))
    if (hi - lo < Math.round(MIN_AD_SEC / SEC_PER_FRAME)) continue
    const slice = canonicalFp.slice(lo, hi)
    const sig = (slice[Math.floor(slice.length / 2)]! >>> 0).toString(16) + ':' + slice.length
    await db.insert(podcastAdFingerprints).values({
      id: crypto.randomUUID(), showId, sig, fp: packFp(slice), frames: slice.length,
      durationSec: Math.round(r.endSec - r.startSec), createdAt: now,
    }).onConflictDoNothing().catch(() => {})
  }
}

/** Match an episode's fingerprints against this show's remembered ads. For each stored ad
 *  we anchor on its middle frame (cheap exact/near lookup) then verify the whole window. */
export async function matchKnownAds(showId: string | null, canonicalFp: Uint32Array | null): Promise<AudioAdRange[]> {
  if (!showId || !canonicalFp || !canonicalFp.length) return []
  const known = await db.select().from(podcastAdFingerprints)
    .where(eq(podcastAdFingerprints.showId, showId)).orderBy(desc(podcastAdFingerprints.createdAt)).limit(MAX_KNOWN_ADS).catch(() => [])
  if (!known.length) return []
  const E = canonicalFp
  const out: AudioAdRange[] = []
  for (const k of known) {
    const S = unpackFp(k.fp)
    if (S.length < 8 || S.length > E.length) continue
    const anchor = S[Math.floor(S.length / 2)]! >>> 0
    if (anchor === 0) continue
    for (let start = 0; start + S.length <= E.length; start++) {
      // Cheap gate: the anchor frame must be near before we score the whole window.
      if (popcount32((E[start + Math.floor(S.length / 2)]! >>> 0) ^ anchor) > MEM_MATCH_BITS) continue
      let bad = 0
      const budget = Math.ceil(S.length * 0.25)
      let ok = true
      for (let i = 0; i < S.length; i++) {
        if (S[i] === 0) continue
        if (popcount32((E[start + i]! >>> 0) ^ (S[i]! >>> 0)) > MEM_MATCH_BITS) { if (++bad > budget) { ok = false; break } }
      }
      if (ok) {
        out.push({ startSec: start * SEC_PER_FRAME, endSec: (start + S.length) * SEC_PER_FRAME, kind: 'ad', confidence: 0.85 })
        start += S.length                                     // don't re-match the same span
      }
    }
  }
  if (out.length) logger.info(`[podcast-ad-fp] matched ${out.length} known ad(s) for show ${showId}`)
  return out
}
