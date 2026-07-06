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

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/** YouTube's auto-caption VTT text is HTML-entity-encoded (confirmed live: `&gt;&gt;` for a
 *  literal `>>` speaker-change marker, `&nbsp;` inside the `[&nbsp;__&nbsp;]` bleep-censor
 *  placeholder) — decode before this text ever reaches a human-readable .srt. */
function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return NAMED_ENTITIES[ent] ?? m
  })
}

/** Parse WebVTT cues, stripping YouTube's inline word-level timing tags (`<00:00:01.234>`,
 *  `<c>...</c>`) and decoding HTML entities down to plain cue text. Does NOT reconstruct
 *  YouTube's overlapping "rolling caption" windows into real sentences — see
 *  reconstructWords()/sentenceizeWords() for that. */
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
      const text = decodeHtmlEntities(textLines.join(' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
      if (text) cues.push({ start, end, text })
    }
    i++
  }
  return cues
}

interface TimedWord { text: string; time: number }

/** YouTube's auto-captions are "rolling": each cue re-shows the tail of the previous cue's
 *  text plus a few new words, rather than one cue per sentence (confirmed live — cue 2's
 *  text starts with cue 1's exact tail, then extends). Reconstruct the true, non-overlapping
 *  word stream by finding the longest run of already-emitted words that matches the START of
 *  each new cue, and only appending the genuinely new trailing words — with their timestamp
 *  interpolated across that cue's [start, end] span by word position. */
function reconstructWords(cues: Cue[]): TimedWord[] {
  const out: TimedWord[] = []
  for (const cue of cues) {
    const words = cue.text.split(/\s+/).filter(Boolean)
    if (!words.length) continue
    const maxCheck = Math.min(words.length, out.length, 20)
    let overlap = 0
    for (let k = maxCheck; k > 0; k--) {
      const tail = out.slice(out.length - k).map(w => w.text).join(' ')
      const head = words.slice(0, k).join(' ')
      if (tail === head) { overlap = k; break }
    }
    const newWords = words.slice(overlap)
    const span = Math.max(cue.end - cue.start, 0.01)
    newWords.forEach((text, idx) => {
      out.push({ text, time: cue.start + span * ((overlap + idx) / words.length) })
    })
  }
  return out
}

const SENTENCE_END_RE = /[.!?]["')\]]?$/
const MAX_SENTENCE_WORDS = 40 // safety break for long stretches with no terminal punctuation

/** Group a reconstructed, non-overlapping word stream into sentence-sized cues — plain
 *  fragment-per-cue captions (YouTube's raw rolling style) are hard to read; real sentences
 *  aren't. */
function sentenceizeWords(words: TimedWord[]): Cue[] {
  const out: Cue[] = []
  let buf: TimedWord[] = []
  const flush = (endTime: number) => {
    if (!buf.length) return
    out.push({ start: buf[0]!.time, end: Math.max(endTime, buf[0]!.time + 0.5), text: buf.map(w => w.text).join(' ') })
    buf = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    buf.push(w)
    const next = words[i + 1]
    if (SENTENCE_END_RE.test(w.text) || buf.length >= MAX_SENTENCE_WORDS) flush(next?.time ?? w.time)
  }
  flush(words[words.length - 1]?.time ?? 0)
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
  const cues = sentenceizeWords(reconstructWords(parseVtt(vtt)))
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
