// Loads YouTube's IFrame Player API once, app-wide. Both the watch-page player and the
// docked mini-player create YT.Player instances against it. Resolves with window.YT.

declare global { interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void } }

let ytApiPromise: Promise<any> | null = null

export function loadYTApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (!ytApiPromise) {
    ytApiPromise = new Promise(resolve => {
      const prev = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT) }
      const tag = document.createElement('script')
      tag.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(tag)
    })
  }
  return ytApiPromise
}
