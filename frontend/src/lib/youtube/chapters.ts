// Parse chapter markers out of a video description. Creators list them as timestamped
// lines (e.g. "0:00 Intro", "1:23 - First topic"). YouTube only treats them as chapters
// when the first timestamp is 0:00 and there are at least a few — we apply the same rule
// so random timestamps scattered in a description don't get mistaken for chapters.

export interface Chapter { start: number; title: string }

// A timestamp at a word boundary: m:ss or h:mm:ss.
const TS = /(?:^|\s)(\d{1,2}):([0-5]?\d)(?::([0-5]\d))?(?=\s|$)/

export function parseChapters(description: string | null | undefined): Chapter[] {
  if (!description) return []
  const out: Chapter[] = []

  for (const raw of description.split('\n')) {
    const line = raw.trim()
    const m = TS.exec(line)
    if (!m) continue
    const h = m[3] != null ? parseInt(m[1], 10) : 0
    const min = m[3] != null ? parseInt(m[2], 10) : parseInt(m[1], 10)
    const sec = m[3] != null ? parseInt(m[3], 10) : parseInt(m[2], 10)
    const start = h * 3600 + min * 60 + sec

    // Title is the rest of the line, stripped of the timestamp and leading/trailing
    // separators (-, –, :, ), ], etc.).
    const idx = m.index + (m[0].startsWith(' ') ? 1 : 0)
    const title = (line.slice(0, idx) + line.slice(m.index + m[0].length))
      .replace(/^[\s\-–—:)\].·|]+|[\s\-–—:|]+$/g, '')
      .trim()
    if (title) out.push({ start, title })
  }

  if (out.length < 2) return []
  out.sort((a, b) => a.start - b.start)
  if (out[0]!.start !== 0) return []   // not a real chapter list
  return out.filter((ch, i) => i === 0 || ch.start !== out[i - 1]!.start)
}

/** Index of the chapter containing `positionSec`, or -1. */
export function activeChapter(chapters: Chapter[], positionSec: number): number {
  let idx = -1
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i]!.start <= positionSec + 0.5) idx = i
    else break
  }
  return idx
}
