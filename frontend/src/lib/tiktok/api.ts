// TikTok's official embed-player postMessage control API
// (developers.tiktok.com/doc/embed-player). No JS SDK is published for it (unlike Vimeo's
// Player.js or YouTube's IFrame API); this is a thin wrapper around the raw message
// contract: commands go out tagged 'x-tiktok-player', state comes back push-only as events.

export type TikTokPlayerEvent =
  | { type: 'onPlayerReady' }
  | { type: 'onStateChange'; value: -1 | 0 | 1 | 2 | 3 } // init/ended/playing/paused/buffering
  | { type: 'onCurrentTime'; value: { currentTime: number; duration: number } }
  | { type: 'onMute'; value: boolean }
  | { type: 'onVolumeChange'; value: number }
  | { type: 'onPlayerError'; value: { errorCode: number; errorType: string } }

function send(iframe: HTMLIFrameElement, type: string, value?: unknown) {
  iframe.contentWindow?.postMessage({ 'x-tiktok-player': true, type, value }, '*')
}

export const tiktokCommands = {
  play: (iframe: HTMLIFrameElement) => send(iframe, 'play'),
  pause: (iframe: HTMLIFrameElement) => send(iframe, 'pause'),
  seekTo: (iframe: HTMLIFrameElement, sec: number) => send(iframe, 'seekTo', sec),
  mute: (iframe: HTMLIFrameElement) => send(iframe, 'mute'),
  unMute: (iframe: HTMLIFrameElement) => send(iframe, 'unMute'),
}

// Filters window 'message' events down to ones from this specific iframe (TikTok's example
// posts to '*', so the origin alone can't be trusted to scope it).
export function onTikTokMessage(iframe: HTMLIFrameElement, cb: (msg: TikTokPlayerEvent) => void) {
  const handler = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return
    const data = e.data as { type?: string } | null
    if (!data?.type) return
    cb(data as TikTokPlayerEvent)
  }
  window.addEventListener('message', handler)
  return () => window.removeEventListener('message', handler)
}
