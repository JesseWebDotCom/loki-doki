// Minimal WebVTT parser → timestamped, de-duplicated transcript lines for the
// clickable transcript panel. Falls back gracefully (callers use prose if empty).

import { decodeEntities } from '@/lib/htmlText'

export interface TranscriptLine { sec: number; label: string; text: string }

function toSec(stamp: string): number {
  // HH:MM:SS.mmm or MM:SS.mmm
  const parts = stamp.trim().split(':').map(Number)
  if (parts.some(isNaN)) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] ?? 0
}

export function clockLabel(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const CUE_RE = /(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)/

/** Parse a .vtt document into clean, de-duplicated, timestamped lines. */
export function parseVtt(vtt: string): TranscriptLine[] {
  if (!vtt || !/-->/.test(vtt)) return []
  const blocks = vtt.replace(/\r/g, '').split('\n\n')
  const out: TranscriptLine[] = []
  let lastText = ''
  for (const block of blocks) {
    const lines = block.split('\n')
    const cueLine = lines.find(l => CUE_RE.test(l))
    if (!cueLine) continue
    const m = cueLine.match(CUE_RE)
    if (!m) continue
    const sec = toSec(m[1])
    const text = decodeEntities(lines
      .filter(l => !CUE_RE.test(l) && !/^WEBVTT/i.test(l) && !/^(Kind|Language):/i.test(l) && !/^\d+$/.test(l.trim()))
      .join(' ')
      .replace(/<[^>]+>/g, ''))        // inline timing/cue tags
      .replace(/(^|\s)>+(?=\s|$)/g, ' ') // ">>" speaker-change markers → drop
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    // Rolling-caption dedup: skip if it's a substring of the previous (or vice-versa).
    if (text === lastText || (lastText && lastText.endsWith(text)) || (lastText && text.startsWith(lastText))) {
      if (text.length > lastText.length && out.length) { out[out.length - 1] = { sec: out[out.length - 1].sec, label: out[out.length - 1].label, text }; lastText = text }
      continue
    }
    out.push({ sec, label: clockLabel(sec), text })
    lastText = text
  }
  return out
}
