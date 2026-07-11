import { Play, Pause, Volume2, VolumeX, Maximize } from 'lucide-react'
import { fmtClock } from '@/lib/youtube/format'
import { SeekBar } from '@/components/shared/SeekBar'

// One volume level shared by every player surface (same key the YouTube player uses).
const VOLUME_KEY = 'yt.volume'
export function readStoredVolume(): number {
  try { const v = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? '1'); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1 } catch { return 1 }
}
export function storeVolume(v: number): void {
  try { localStorage.setItem(VOLUME_KEY, String(Math.min(1, Math.max(0, v)))) } catch { /* quota */ }
}

export interface PlayerControlBarProps {
  playing: boolean
  muted: boolean
  position: number
  duration: number
  onToggle: () => void
  onToggleMute: () => void
  onSeek: (sec: number) => void
  onFullscreen: () => void
  /** Volume level + setter; omitted for players whose API is mute-only (TikTok). */
  volume?: number
  onVolume?: (v: number) => void
}

/**
 * Minimal play/pause + mute (+ volume slider where supported) + scrubber + time +
 * fullscreen bar, hover-revealed over a video surface. Shared by every hub source whose
 * native chrome we hide (controls=0 Vimeo/TikTok embeds, or a native <video> with its
 * `controls` attribute dropped), so they all get the same look instead of duplicating
 * this JSX per source. The parent must be a `group relative` container the same size as
 * the video surface.
 */
export function PlayerControlBar({ playing, muted, position, duration, onToggle, onToggleMute, onSeek, onFullscreen, volume, onVolume }: PlayerControlBarProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 translate-y-2 bg-gradient-to-t from-black/80 to-transparent px-4 pb-3 pt-8 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100 group-hover:pointer-events-auto">
      <SeekBar pos={position} total={duration} onSeek={onSeek} className="mb-3" />
      <div className="flex items-center gap-4 text-white">
        <button onClick={onToggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 fill-current" />}
        </button>
        {/* Mute + a hover-expanding volume slider where the backing player supports levels. */}
        <div className="group/vol flex items-center">
          <button onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted || volume === 0 ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </button>
          {onVolume && (
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : (volume ?? 1)}
              onChange={e => onVolume(Number(e.target.value))} aria-label="Volume"
              className="ml-0 w-0 cursor-pointer opacity-0 transition-all duration-200 accent-[var(--yt-accent)] group-hover/vol:ml-2 group-hover/vol:w-20 group-hover/vol:opacity-100" />
          )}
        </div>
        <span className="text-xs tabular-nums text-white/80">{fmtClock(position)} / {fmtClock(duration)}</span>
        <div className="flex-1" />
        <button onClick={onFullscreen} aria-label="Fullscreen"><Maximize className="size-5" /></button>
      </div>
    </div>
  )
}
