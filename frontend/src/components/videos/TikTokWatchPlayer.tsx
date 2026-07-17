import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { useTikTokPlayer } from '@/hooks/use-tiktok-player'
import type { WtPlayerControls } from '@/hooks/useWatchTogether'
import { useFullscreenToggle } from '@/hooks/use-fullscreen-toggle'
import { PlayerControlBar } from '@/components/videos/PlayerControlBar'
import { PlayerClickToggle } from '@/components/videos/PlayerClickToggle'

/**
 * TikTok watch-page player. Same reasoning as VimeoWatchPlayer: controls=0 hides TikTok's
 * native chrome entirely (there's no way to hide just individual buttons), replaced here
 * with the shared PlayerControlBar driven by TikTok's postMessage embed-player API. That
 * API is thinner than Vimeo's Player.js (no volume level, only mute/unMute), so mute is a
 * true toggle rather than a remembered volume.
 */
export function TikTokWatchPlayer({ embedUrl, title, vertical, resumeSec, onProgress, controlsRef }: {
  embedUrl: string; title: string; vertical: boolean
  /** Saved position to jump to once playback starts (cross-device resume). */
  resumeSec?: number
  /** Live position feed so the watch page can sync watch state (the iframe is opaque to it). */
  onProgress?: (sec: number, dur: number) => void
  /** Imperative transport handle for Watch Together (play/pause/seek/observe). */
  controlsRef?: React.MutableRefObject<WtPlayerControls | null>
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const posRef = useRef(0)
  const playingRef = useRef(false)

  const player = useTikTokPlayer(iframeRef, embedUrl, {
    onPlay: () => { playingRef.current = true; setPlaying(true) },
    onPause: () => { playingRef.current = false; setPlaying(false) },
    onTimeUpdate: (sec, dur) => { posRef.current = sec; setPosition(sec); setDuration(dur); onProgress?.(sec, dur) },
  })
  const toggleFullscreen = useFullscreenToggle(wrapRef)

  useEffect(() => {
    if (!controlsRef) return
    controlsRef.current = {
      play: () => player.play(),
      pause: () => player.pause(),
      seek: (sec) => { player.seek(sec); posRef.current = sec },
      isPlaying: () => playingRef.current,
      position: () => posRef.current,
    }
    return () => { controlsRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- player methods delegate through a stable internal ref
  }, [controlsRef])

  // Cross-device resume: seek to the saved position once playback first starts (the embed
  // ignores seeks issued before the player is actually running).
  const appliedResume = useRef(false)
  useEffect(() => {
    if (!playing || appliedResume.current) return
    appliedResume.current = true
    if (resumeSec && resumeSec > 1) player.seek(resumeSec)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  const toggle = () => (playing ? player.pause() : player.play())
  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    next ? player.mute() : player.unMute()
  }

  return (
    <div ref={wrapRef} className={cn('group relative overflow-hidden bg-black', vertical && 'rounded-card',
      vertical ? 'aspect-[9/16] h-[min(64vh,600px)]' : 'aspect-video w-full')}>
      <iframe ref={iframeRef} src={embedUrl} title={title}
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen
        className="size-full border-0" />
      <PlayerClickToggle playing={playing} onToggle={toggle} />
      <PlayerControlBar playing={playing} muted={muted} position={position} duration={duration}
        onToggle={toggle}
        onToggleMute={toggleMute}
        onSeek={(sec) => player.seek(sec)}
        onFullscreen={toggleFullscreen} />
    </div>
  )
}
