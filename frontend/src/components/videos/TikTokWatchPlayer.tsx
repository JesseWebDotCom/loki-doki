import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { useTikTokPlayer } from '@/hooks/use-tiktok-player'
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
export function TikTokWatchPlayer({ embedUrl, title, vertical }: { embedUrl: string; title: string; vertical: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)

  const player = useTikTokPlayer(iframeRef, embedUrl, {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onTimeUpdate: (sec, dur) => { setPosition(sec); setDuration(dur) },
  })
  const toggleFullscreen = useFullscreenToggle(wrapRef)

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
