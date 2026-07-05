// Re-time captions in lockstep with a video cut. Consumes the EXACT SAME keepRanges list
// videoCut.ts used, so captions can never drift out of sync — there is no independent
// timing computation here, only a remap through the same piecewise time function.
//
// The source is real per-cue timed WebVTT (ensureTranscript()/fetchTranscript() in
// youtube/download.ts), not the plain-text form transcript.ts's cleanVttText() produces —
// that one throws timing away entirely and is unrelated to this module.

import type { Range } from './videoCut'

export interface Cue { start: number; end: number; text: string }

const TIME_RE = /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/

function toSec(ts: string): number {
  const parts = ts.split(':').map(Number)
  return parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts[0]! * 60 + parts[1]!
}

/** Parse WebVTT cues, stripping YouTube's inline word-level timing tags (`<00:00:01.234>`,
 *  `<c>...</c>`) down to plain cue text. Does NOT dedupe rolling-caption repeats — see
 *  dedupeRollingCues() for that, kept separate so this stays a pure "what does the file
 *  literally say" parser. */
export function parseVtt(vtt: string): Cue[] {
  const lines = vtt.split(/\r?\n/)
  const cues: Cue[] = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i]?.match(TIME_RE)
    if (m) {
      const start = toSec(m[1]!)
      const end = toSec(m[2]!)
      i++
      const textLines: string[] = []
      while (i < lines.length && lines[i]!.trim() !== '') { textLines.push(lines[i]!); i++ }
      const text = textLines.join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      if (text) cues.push({ start, end, text })
    }
    i++
  }
  return cues
}

/** Collapse consecutive rolling-caption duplicates (identical text, back to back) into one
 *  cue spanning the full run — same de-dup idea as transcript.ts's cleanVttText(), but keeps
 *  real per-cue timing instead of discarding it (needed for a real SRT, not prose). */
export function dedupeRollingCues(cues: Cue[]): Cue[] {
  const out: Cue[] = []
  for (const c of cues) {
    const last = out[out.length - 1]
    if (last && last.text === c.text) { last.end = c.end; continue }
    out.push({ ...c })
  }
  return out
}

/** Map a timestamp in the ORIGINAL timeline to its position in the CUT timeline — a
 *  timestamp that falls inside a removed range clamps to wherever that range's start now
 *  maps to. Identical piecewise function videoCut.ts's ranges describe, just walked here
 *  instead of handed to ffmpeg. */
function remapTime(t: number, keepRanges: Range[]): number {
  let mapped = 0
  for (const r of keepRanges) {
    if (t <= r.start) return mapped
    if (t <= r.end) return mapped + (t - r.start)
    mapped += r.end - r.start
  }
  return mapped
}

function fmtSrtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}

/**
 * Cut+shift cues against `keepRanges` (the SAME list videoCut.ts used) and render valid
 * SRT. A cue spanning a cut boundary splits into one entry per surviving fragment; a cue
 * entirely inside a removed range is dropped. This is the only place caption timing gets
 * computed — never re-derive it independently, or captions and video WILL drift apart.
 */
export function cutAndRenderSrt(vtt: string, keepRanges: Range[]): string {
  const cues = dedupeRollingCues(parseVtt(vtt))
  const entries: string[] = []
  let index = 1
  for (const cue of cues) {
    for (const r of keepRanges) {
      const start = Math.max(cue.start, r.start)
      const end = Math.min(cue.end, r.end)
      if (end - start <= 0.02) continue // negligible/no overlap with this keep range
      const newStart = remapTime(start, keepRanges)
      const newEnd = remapTime(end, keepRanges)
      if (newEnd - newStart <= 0.02) continue
      entries.push(`${index}\n${fmtSrtTime(newStart)} --> ${fmtSrtTime(newEnd)}\n${cue.text}\n`)
      index++
    }
  }
  return entries.join('\n')
}
