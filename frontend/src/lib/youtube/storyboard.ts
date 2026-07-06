import type { StoryboardLevel } from '@/lib/youtube/api'

/** Pick the level to use for scrub-preview: the finest-grained (smallest interval)
 *  level whose sprite atlas stays small, so a scrub session doesn't fetch dozens of
 *  full sheets for a very long video. Falls back to the coarsest level available. */
export function pickStoryboardLevel(levels: StoryboardLevel[]): StoryboardLevel | null {
  if (!levels.length) return null
  const byFinest = [...levels].sort((a, b) => a.intervalMs - b.intervalMs)
  return byFinest.find(l => l.sheetCount <= 20) ?? levels[levels.length - 1]!
}

/** Map a playback timestamp to the sprite sheet URL + grid cell that holds its frame. */
export function frameForTime(level: StoryboardLevel, sec: number): { sheetUrl: string; col: number; row: number } {
  const perSheet = level.cols * level.rows
  const frameIndex = Math.min(level.totalCount - 1, Math.max(0, Math.floor((sec * 1000) / level.intervalMs)))
  const sheetIndex = Math.floor(frameIndex / perSheet)
  const within = frameIndex % perSheet
  return {
    sheetUrl: level.urlTemplate.replace('{sheet}', String(sheetIndex)),
    col: within % level.cols,
    row: Math.floor(within / level.cols),
  }
}
