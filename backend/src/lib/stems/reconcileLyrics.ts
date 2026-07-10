// Cross-check our own forced-alignment output (tied to THIS recording's actual vocals)
// against LRCLIB's trusted, human-curated synced lyrics. LRCLIB's timing is for whatever
// upload matched by artist/title/duration — often the exact same recording (just maybe a
// second of silence trimmed/added at the front), but sometimes a genuinely different
// edit/re-record/cover, where its timing has nothing to do with our audio.
//
// So: measure the offset between the two on lines we can confidently pair up. If they agree
// (after a constant shift) on most lines, LRCLIB is the same recording — use it to repair
// the handful of lines where our aligner likely misfired (a bad CTC anchor makes the karaoke
// highlight jump early/late). If they don't agree, it's a different recording — LRCLIB's
// timing would only make things worse, so keep our own alignment untouched.
//
// We never adopt LRCLIB's timing wholesale: it's line-level only, while our alignment is
// per-word. It's used purely as a validator + a per-line offset corrector.

export interface AlignedWord { sec: number; end: number; text: string }
export interface AlignedLine { sec: number; text: string; words: AlignedWord[] }
export interface LrcLine { sec: number; text: string }

export interface ReconcileResult {
  lines: AlignedLine[]
  source: 'forced' | 'lrclib'
  offsetSec: number      // constant shift applied to repaired outlier lines (lrclib -> audio time)
  matchedFrac: number     // fraction of non-blank aligned lines LRCLIB could confirm
  spread: number          // median absolute deviation of matched-line deltas, in seconds
}

const MIN_MATCHED_FRAC = 0.6   // need to confirm most of the song to call it "the same recording"
const MAX_SPREAD_SEC = 0.4     // MAD of deltas above this = LRCLIB isn't reliably the same recording
const OUTLIER_DELTA_SEC = 0.6  // a line whose own delta is this far from the median is a likely misfire
const RESYNC_WINDOW = 3        // lines to look ahead when a skipped/inserted line breaks 1:1 order
const MIN_LINE_GAP_SEC = 0.3   // a repair may never squeeze a line this close to its neighbours

function normalizeLine(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

// Pair aligned lines to LRCLIB lines in order, tolerating a small window of skipped/extra
// lines on either side (e.g. LRCLIB includes a blank instrumental marker ours doesn't).
function pairLines(aligned: AlignedLine[], lrclib: LrcLine[]): Array<{ a: AlignedLine; l: LrcLine }> {
  const pairs: Array<{ a: AlignedLine; l: LrcLine }> = []
  let li = 0
  for (const a of aligned) {
    const an = normalizeLine(a.text)
    if (!an) continue
    let found = -1
    for (let w = 0; w <= RESYNC_WINDOW && li + w < lrclib.length; w++) {
      if (normalizeLine(lrclib[li + w]!.text) === an) { found = li + w; break }
    }
    if (found >= 0) { pairs.push({ a, l: lrclib[found]! }); li = found + 1 }
  }
  return pairs
}

export function reconcile(aligned: AlignedLine[], lrclib: LrcLine[] | null): ReconcileResult {
  const nonBlank = aligned.filter((l) => normalizeLine(l.text))
  if (!lrclib?.length || nonBlank.length === 0) {
    return { lines: aligned, source: 'forced', offsetSec: 0, matchedFrac: 0, spread: 0 }
  }

  const pairs = pairLines(aligned, lrclib)
  const matchedFrac = pairs.length / nonBlank.length
  if (pairs.length < 2 || matchedFrac < MIN_MATCHED_FRAC) {
    return { lines: aligned, source: 'forced', offsetSec: 0, matchedFrac, spread: 0 }
  }

  const deltas = pairs.map(({ a, l }) => l.sec - a.sec)
  const med = median(deltas)
  const spread = median(deltas.map((d) => Math.abs(d - med)))
  if (spread > MAX_SPREAD_SEC) {
    return { lines: aligned, source: 'forced', offsetSec: 0, matchedFrac, spread }
  }

  // Trusted match: repair only the lines whose own delta is an outlier (likely a misfired
  // anchor), by shifting that line's start + its words by the amount needed to land on
  // LRCLIB's offset-corrected time. Lines that already agree are left as our own alignment
  // produced them — they're per-word already, which LRCLIB isn't. A repair that would land
  // out of order (or within MIN_LINE_GAP_SEC of a neighbour) is dropped — a slightly-off
  // line beats one that reorders the display and flashes past.
  const byLine = new Map(pairs.map(({ a, l }) => [a, l]))
  const repaired: AlignedLine[] = []
  for (let i = 0; i < aligned.length; i++) {
    const line = aligned[i]!
    const l = byLine.get(line)
    const delta = l ? l.sec - line.sec : 0
    if (!l || Math.abs(delta - med) <= OUTLIER_DELTA_SEC) { repaired.push(line); continue }
    const candidate = round3(l.sec - med)
    const prevSec = repaired[repaired.length - 1]?.sec ?? -Infinity
    const nextSec = aligned[i + 1]?.sec ?? Infinity
    if (candidate < prevSec + MIN_LINE_GAP_SEC || candidate > nextSec - MIN_LINE_GAP_SEC) { repaired.push(line); continue }
    const shift = candidate - line.sec
    repaired.push({
      sec: candidate,
      text: line.text,
      words: line.words.map((w) => ({ sec: round3(w.sec + shift), end: round3(w.end + shift), text: w.text })),
    })
  }

  return { lines: repaired, source: 'lrclib', offsetSec: -med, matchedFrac, spread }
}

function round3(n: number): number { return Math.round(n * 1000) / 1000 }
