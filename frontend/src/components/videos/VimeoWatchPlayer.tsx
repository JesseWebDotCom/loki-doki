import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { useVimeoPlayer } from '@/hooks/use-vimeo-player'
import { useFullscreenToggle } from '@/hooks/use-fullscreen-toggle'
import { PlayerControlBar } from '@/components/videos/PlayerControlBar'
import { PlayerClickToggle } from '@/components/videos/PlayerClickToggle'

/**
 * Vimeo watch-page player. Vimeo won't let an embedder hide just the Like/Watch Later
 * buttons on someone else's video (that's a paid-plan, owner-configured "player skin"
 * feature), so the only universal lever is controls=0, which strips ALL native chrome.
 * This replaces it with the shared PlayerControlBar, driven by Vimeo's Player.js SDK.
 */
export function VimeoWatchPlayer({ embedUrl, title, vertical }: { embedUrl: string; title: string; vertical: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)

  const player = useVimeoPlayer(iframeRef, embedUrl, {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onTimeUpdate: (sec, dur) => { setPosition(sec); setDuration(dur) },
  })
  const toggleFullscreen = useFullscreenToggle(wrapRef)

  const toggle = () => (playing ? player.pause() : player.play())
  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    player.setVolume(next ? 0 : 1)
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
