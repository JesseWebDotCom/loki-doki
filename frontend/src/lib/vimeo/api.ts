// Loads Vimeo's Player.js SDK once, app-wide. Used to drive controls=0 Vimeo embeds
// (play/pause/seek/volume) over postMessage now that the native chrome is hidden; see
// backend/src/lib/videos/providers/vimeo.ts for why.

declare global { interface Window { Vimeo?: { Player: new (el: HTMLIFrameElement) => VimeoPlayer } } }

export interface VimeoPlayer {
  on(event: 'play' | 'pause' | 'ended', cb: () => void): void
  on(event: 'timeupdate', cb: (data: { seconds: number; duration: number }) => void): void
  play(): Promise<void>
  pause(): Promise<void>
  setCurrentTime(sec: number): Promise<number>
  setVolume(vol: number): Promise<number>
  destroy(): Promise<void>
}

let vimeoApiPromise: Promise<NonNullable<Window['Vimeo']>> | null = null

export function loadVimeoApi(): Promise<NonNullable<Window['Vimeo']>> {
  if (window.Vimeo?.Player) return Promise.resolve(window.Vimeo)
  if (!vimeoApiPromise) {
    vimeoApiPromise = new Promise(resolve => {
      const tag = document.createElement('script')
      tag.src = 'https://player.vimeo.com/api/player.js'
      tag.onload = () => resolve(window.Vimeo!)
      document.head.appendChild(tag)
    })
  }
  return vimeoApiPromise
}
