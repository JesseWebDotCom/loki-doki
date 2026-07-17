// Companion listen/watch-along: helpers that turn live playback state (music, podcasts,
// videos) into the LLM-friendly context lines published through UIContextProvider.
// Everything here is pure formatting — the players own the state, the bridge component
// (components/shell/NowPlayingCompanionBridge) and the video watch page own the wiring.

import type { LyricLine } from '@/lib/music/catalogApi'
import type { TranscriptLine } from '@/lib/youtube/transcript'
import type { TranscriptTurn } from '@/context/PodcastPlaybackContext'

/** Shared behavioral note appended to every media context block. */
export const MEDIA_GUIDANCE =
  'You are experiencing this with the user in real time — you know exactly where they are in it. ' +
  'When they say things like "this song", "what did he just say", or "who is this", they mean the media above. ' +
  'React like a friend enjoying it alongside them, grounded in what has actually played so far. ' +
  'Never reveal or spoil anything past the current position.'

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

export function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/** "3:12 of 4:05" — omits the total when it isn't known (live streams, loading). */
export function fmtProgress(positionSec: number, durationSec?: number | null): string {
  return durationSec && durationSec > 0
    ? `${fmtClock(positionSec)} of ${fmtClock(durationSec)}`
    : fmtClock(positionSec)
}

/** The synced-lyric lines sung so far, most recent last, "»" marking the current line. */
export function lyricsWindow(lines: LyricLine[], positionSec: number, maxLines = 8, maxChars = 600): string {
  const sung = lines.filter(l => l.sec <= positionSec + 0.5 && l.text.trim())
  if (!sung.length) return ''
  const recent = sung.slice(-maxLines)
  const out: string[] = []
  let used = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = `${i === recent.length - 1 ? '» ' : ''}${recent[i]!.text.trim()}`
    if (used + line.length > maxChars && out.length) break
    out.unshift(line)
    used += line.length
  }
  return `Lyrics sung so far (most recent last, » = the line being sung right now):\n${out.join('\n')}`
}

/** Timestamped caption/transcript lines already spoken, most recent last. */
export function timedTranscriptWindow(lines: TranscriptLine[], positionSec: number, maxLines = 8, maxChars = 900): string {
  const spoken = lines.filter(l => l.sec <= positionSec + 0.25)
  if (!spoken.length) return ''
  const recent = spoken.slice(-maxLines)
  const out: string[] = []
  let used = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = `[${recent[i]!.label}] ${recent[i]!.text}`
    if (used + line.length > maxChars && out.length) break
    out.unshift(line)
    used += line.length
  }
  return `What was just said (most recent last):\n${out.join('\n')}`
}

/** Untimed speaker turns (generated-podcast scripts): estimate where the playhead is by
 *  fraction of the episode elapsed, and show the turns around that point. */
export function estimatedTranscriptWindow(turns: TranscriptTurn[], positionSec: number, durationSec: number, maxTurns = 5, maxChars = 1000): string {
  if (!turns.length || !(durationSec > 0)) return ''
  const frac = Math.max(0, Math.min(1, positionSec / durationSec))
  const idx = Math.min(turns.length - 1, Math.floor(frac * turns.length))
  const recent = turns.slice(Math.max(0, idx - (maxTurns - 1)), idx + 1)
  const out: string[] = []
  let used = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = `${recent[i]!.speaker}: ${truncate(recent[i]!.text, 240)}`
    if (used + line.length > maxChars && out.length) break
    out.unshift(line)
    used += line.length
  }
  return `Transcript excerpt near the current position (timing estimated, most recent last):\n${out.join('\n')}`
}

/** One shared shape for the video watch-along block — used by the docked mini-player
 *  bridge and the full watch page so both read identically to the companion. */
export function videoCompanionBlock(p: {
  title: string
  author?: string | null
  positionSec: number
  durationSec?: number | null
  playing: boolean
  lines: TranscriptLine[]
}): string {
  const parts = [
    `The user is watching the video "${p.title}"${p.author ? ` by ${p.author}` : ''} — at ${fmtProgress(p.positionSec, p.durationSec)}, currently ${p.playing ? 'playing' : 'paused'}.`,
  ]
  const window = timedTranscriptWindow(p.lines, p.positionSec)
  if (window) parts.push(window)
  parts.push(MEDIA_GUIDANCE)
  return parts.join('\n')
}
