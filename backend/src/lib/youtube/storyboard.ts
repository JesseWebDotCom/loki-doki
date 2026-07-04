// Parses InnerTube's `storyboards.playerStoryboardSpecRenderer.spec` string into the
// sprite-sheet levels used for scrub-preview thumbnails (the small frame that pops up
// over the seek bar while hovering/dragging, like Netflix/Plex's trickplay).
//
// The spec is a pipe-delimited string: element 0 is a URL template (with `$L`/`$N`
// placeholders for the level index and sheet name), followed by one `#`-delimited
// descriptor per level: `width#height#totalFrameCount#cols#rows#intervalMs#name#sigh`.
// This is YouTube's own format (undocumented, but stable — same one yt-dlp's
// `_extract_storyboard_info` targets); verified here against a live response before
// writing this parser.

export interface StoryboardLevel {
  width: number
  height: number
  cols: number
  rows: number
  totalCount: number
  intervalMs: number
  sheetCount: number
  // URL template for this level with `$L` (level) and `$N`/sigh already resolved, and a
  // literal "{sheet}" placeholder standing in for whatever multi-sheet index ($M) this
  // level needs — callers just do `.replace('{sheet}', String(i))`.
  urlTemplate: string
}

export function parseStoryboardSpec(spec: string): StoryboardLevel[] {
  const parts = spec.split('|')
  if (parts.length < 2) return []
  const base = parts[0]!
  const levels: StoryboardLevel[] = []
  for (let i = 0; i < parts.length - 1; i++) {
    const f = parts[i + 1]!.split('#')
    if (f.length < 8) continue
    const width = parseInt(f[0]!, 10)
    const height = parseInt(f[1]!, 10)
    const totalCount = parseInt(f[2]!, 10)
    const cols = parseInt(f[3]!, 10)
    const rows = parseInt(f[4]!, 10)
    const intervalMs = parseInt(f[5]!, 10)
    const name = f[6]!
    const sigh = f[7]!
    if (![width, height, totalCount, cols, rows, intervalMs].every(Number.isFinite) || cols <= 0 || rows <= 0) continue
    // interval 0 is a single whole-video overview sprite (not time-indexed) rather than a
    // real scrub-preview level — skip it, since frameForTime divides by intervalMs.
    if (intervalMs <= 0) continue
    const sheetCount = Math.max(1, Math.ceil(totalCount / (cols * rows)))
    const urlTemplate = `${base.replace('$L', String(i)).replace('$N', name).replace('$M', '{sheet}')}&sigh=${sigh}`
    levels.push({ width, height, cols, rows, totalCount, intervalMs, sheetCount, urlTemplate })
  }
  return levels
}
