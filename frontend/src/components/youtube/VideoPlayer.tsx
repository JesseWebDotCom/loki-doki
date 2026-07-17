import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Play, Pause, Volume2, VolumeX, Maximize, Expand, Zap, PictureInPicture, Music, ShieldCheck, Settings, Check, Captions, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { Spinner } from '@/components/ui/spinner'
import { fmtClock, thumbUrl } from '@/lib/youtube/format'
import { fileUrl, proxyStreamUrl, saveWatchState, getDownloadStatus, getStoryboards, ytImageProxy, REMUX_QUALITIES, type SkipSegment, type WatchMeta, type StreamQuality, type StoryboardLevel, type YtHeatMarker } from '@/lib/youtube/api'
import { activeChapter, type Chapter } from '@/lib/youtube/chapters'
import { pickStoryboardLevel, frameForTime } from '@/lib/youtube/storyboard'
import { VideoThumb } from '@/components/youtube/media'
import { useZoomToFillFullscreen } from '@/hooks/use-zoom-to-fill-fullscreen'
import { useAudioBoost } from '@/hooks/use-audio-boost'
import { useVideoGestures, gestureIndicatorText } from '@/hooks/use-video-gestures'
import { useVideoAmbient } from '@/hooks/use-video-ambient'
import { getChannelSpeed, setChannelSpeed } from '@/lib/videos/channelSpeed'
import { applyDsp, ensureMediaGraph } from '@/lib/mediaAudioGraph'
import { useMediaAnalyser } from '@/hooks/use-media-analyser'
import { AudioVisualizer, useVisualizerPref } from '@/components/shared/AudioVisualizer'
import { paletteFromColors } from '@/lib/artPalette'

// design-ok(hex-in-tsx): canvas fillStyle cannot consume CSS vars; hues match the Videos accent
const VIDEO_AUDIO_PALETTE = paletteFromColors('#22d3ee', '#0891b2')

export interface VideoPlayerHandle {
  seek: (sec: number) => void
  togglePlay: () => void
  pause: () => void
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
// 2160/1440/1080 are server-side remux tiers (split video+audio tracks copied into
// fragmented MP4; above 1080p the video track is VP9/AV1 since h264 stops there); their
// pipes aren't byte-seekable, so the player seeks by re-requesting with an offset.
// 'auto'/'720'/'360' are plain progressive files with native Range seeking. A tier a
// video doesn't have simply serves the best it does (the server picks ≤ the cap).
const PROXY_QUALITIES: { value: StreamQuality; label: string }[] = [
  { value: '2160', label: '4K' }, { value: '1440', label: '1440p' }, { value: '1080', label: '1080p' },
  { value: 'auto', label: '720p (fast seek)' }, { value: '360', label: '360p' },
]
const PROXY_QUALITY_KEY = 'yt.proxyQuality'
// YouTube IFrame API quality level → human label.
const YT_QUALITY_LABEL: Record<string, string> = {
  highres: '4K+', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p', hd720: '720p',
  large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto',
}

// ── YouTube IFrame API loader ──────────────────────────────────────────────────
declare global { interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void } }
let ytApiPromise: Promise<any> | null = null
function loadYTApi(): Promise<any> {
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

export const VideoPlayer = forwardRef<VideoPlayerHandle, {
  videoId: string
  localKind?: 'audio' | 'video'
  resumeSec?: number
  onEnded?: () => void
  // Privacy proxy: stream through our server (native <video>) instead of the YouTube
  // embed, so the browser never contacts Google. Ignored for offline (local) playback.
  privacyProxy?: boolean
  // Called when Picture-in-Picture is requested while still on the plain iframe embed
  // (no native <video> to hand off yet) — the parent should flip privacyProxy on so a
  // real <video> mounts; this component fires PiP itself once it's actually playing.
  onNeedsProxyForPip?: () => void
  // Set by the parent (alongside flipping privacyProxy) when this mount exists
  // specifically to satisfy a pending PiP request — WatchPage remounts VideoPlayer on
  // privacy changes (it's keyed on it), so a local ref set before that remount would be
  // lost; this prop is how the request survives the remount. Consumed once, via
  // onPipRequestHandled, the first time the resulting <video> starts playing.
  autoRequestPip?: boolean
  onPipRequestHandled?: () => void
  // Audio boost (amplify past 100%) needs a real <video>/<audio> element to tap — Web
  // Audio can't touch the cross-origin iframe embed. Same handoff as PiP: when boost is
  // requested while still on the embed, the parent flips privacyProxy on so a native
  // element mounts, and passes autoOpenBoost back so the slider pops open on the new mount.
  onNeedsProxyForBoost?: () => void
  autoOpenBoost?: boolean
  onBoostOpenHandled?: () => void
  // Audio-only: stream just the audio (through our server) and show the video's
  // thumbnail as a static poster; saves bandwidth, keeps the visual context.
  audioOnly?: boolean
  // SponsorBlock segments to auto-skip + mark on the scrubber.
  skipSegments?: SkipSegment[]
  onSkip?: (category: string) => void
  // Chapter markers (parsed from the description) shown on the scrubber.
  chapters?: Chapter[]
  /** "Most replayed" heat markers drawn as a curve under the scrubber (YouTube only). */
  heatMarkers?: YtHeatMarker[]
  // Fires with current playback time (~2×/sec) so callers can follow along (transcript).
  onTime?: (sec: number) => void
  // Fires (~2×/sec) with the play/pause state, letting the watch page decide whether to
  // hand off to the docked mini-player on navigate-away.
  onPlaying?: (playing: boolean) => void
  // Metadata persisted with watch-state so the video appears in History even when it
  // was never in a subscription feed.
  videoMeta?: WatchMeta
  // Frame shape: 'video' self-sizes to 16:9; 'short' fills its parent (the parent
  // sizes the 9:16 box); used by the vertical Shorts feed.
  aspect?: 'video' | 'short'
  /** Square corners for full-bleed cinema surfaces (the watch hero); default keeps rounded-card. */
  frameless?: boolean
  // Page-level playback modes surfaced INSIDE the player's settings menu (Plex-style),
  // so the page chrome stays calm. Provided only where toggling makes sense (online).
  onTogglePrivacy?: () => void
  onToggleAudioOnly?: () => void
  /** Total duration from metadata - the 1080p remux pipe can't report its own. */
  durationHintSec?: number | null
  /** Live ambient color sampled from the playing frame (native playback only; null on
   *  the embed, where the pixels aren't readable). Lets the page's cinema backdrop
   *  breathe with the content instead of sitting on the static thumbnail. */
  onAmbientColor?: (color: string | null) => void
}>(function VideoPlayer({ videoId, localKind, resumeSec = 0, onEnded, privacyProxy = false, onNeedsProxyForPip, autoRequestPip = false, onPipRequestHandled, onNeedsProxyForBoost, autoOpenBoost = false, onBoostOpenHandled, audioOnly = false, skipSegments, onSkip, chapters, heatMarkers, onTime, onPlaying, videoMeta, aspect = 'video', frameless = false, onTogglePrivacy, onToggleAudioOnly, durationHintSec, onAmbientColor }, ref) {
  const stripVariant = useVisualizerPref()
  const wrapRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null)
  const ytRef = useRef<any>(null)
  const lastSave = useRef(0)
  const lastSkip = useRef<string | null>(null)
  // Last known position, used to restore the spot after a quality switch reloads the
  // <video> element (and to resume above the initial resumeSec).
  const posRef = useRef(resumeSec)

  const [playing, setPlaying] = useState(false)
  // Embed idle-state bookkeeping: before first play and after the end there's no frame
  // worth keeping, so the poster cover hides YouTube's cued/endscreen chrome ("More
  // videos" wall). A mid-watch PAUSE keeps the actual frame - only YouTube's paused
  // overlays get masked (top scrim + our control bar forced visible).
  const [started, setStarted] = useState(false)
  const [endedUi, setEndedUi] = useState(false)
  useEffect(() => { setStarted(false); setEndedUi(false) }, [videoId])
  const [pipActive, setPipActive] = useState(false)
  const [position, setPosition] = useState(resumeSec)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [buffering, setBuffering] = useState(true)
  // Playback speed, seeded from this channel's remembered rate (see lib/videos/channelSpeed):
  // set 1.5x once on a lecture channel and every later video from it opens at 1.5x.
  const channelKey = videoMeta?.channelId ?? null
  const [rate, setRateState] = useState(() => getChannelSpeed(channelKey) ?? 1)
  // Re-seed when navigating between channels within one mounted player.
  const seededFor = useRef(channelKey)
  useEffect(() => {
    if (seededFor.current === channelKey) return
    seededFor.current = channelKey
    setRateState(getChannelSpeed(channelKey) ?? 1)
  }, [channelKey])
  // A user-picked rate is remembered for the channel; hold-to-2x is transient and must not
  // be (hence setRateState, not setRate, in the gesture path below).
  const setRate = (r: number) => { setRateState(r); setChannelSpeed(channelKey, r) }
  // Settings popover: which sub-menu is open (null = closed).
  const [menu, setMenu] = useState<null | 'main' | 'speed' | 'quality' | 'sleep'>(null)
  // Captions: OUR toggle, persisted per device, default OFF. The YouTube embed otherwise
  // honors Google's sticky caption preference with no way to turn it off from our chrome
  // (controls: 0) - "it always shows subtitles". The embed is forced to match on ready;
  // the private-stream <video> gets the transcript VTT as a real subtitle track.
  const [ccOn, setCcOn] = useState(() => { try { return localStorage.getItem('yt.captions') === '1' } catch { return false } })
  // The embed re-applies Google's sticky caption preference when playback starts, so a
  // single unload at onReady is not enough - this must be re-enforced on every PLAYING
  // transition. Read the preference through a ref: the player's event closures are
  // created once and would otherwise see the mount-time value forever.
  const ccOnRef = useRef(ccOn)
  const enforceEmbedCc = (y: any, on: boolean) => {
    // Both module names: 'captions' is the HTML5 player's, 'cc' the legacy one - YouTube
    // answers to whichever the current build uses. Turning ON needs an explicit track
    // selection (loadModule alone shows nothing); the tracklist populates asynchronously
    // after the module loads, hence the retry beat. Turning OFF must clear the active
    // track via setOption - unloadModule alone gets overridden by Google's sticky pref.
    try {
      if (on) {
        y.loadModule?.('captions'); y.loadModule?.('cc')
        const pick = () => {
          try {
            const list = (y.getOption?.('captions', 'tracklist') ?? y.getOption?.('cc', 'tracklist') ?? []) as Array<{ languageCode?: string }>
            const track = list.find(t => t.languageCode?.startsWith('en')) ?? list[0]
            if (track) { y.setOption?.('captions', 'track', track); y.setOption?.('cc', 'track', track); return true }
          } catch { /* not ready */ }
          return false
        }
        if (!pick()) setTimeout(() => { if (ccOnRef.current) void pick() }, 600)
      } else {
        y.unloadModule?.('captions'); y.unloadModule?.('cc')
        y.setOption?.('captions', 'track', {}); y.setOption?.('cc', 'track', {})
      }
    } catch { /* embed not ready */ }
  }
  const applyCcToPlayers = (on: boolean) => {
    const y = ytRef.current
    if (y) enforceEmbedCc(y, on)
    const m = mediaRef.current
    if (m instanceof HTMLVideoElement) { for (const t of Array.from(m.textTracks)) t.mode = on ? 'showing' : 'hidden' }
  }
  const toggleCc = () => setCcOn(on => {
    const next = !on
    try { localStorage.setItem('yt.captions', next ? '1' : '0') } catch { /* quota */ }
    ccOnRef.current = next
    applyCcToPlayers(next)
    return next
  })
  const [boostOpen, setBoostOpen] = useState(false)
  // Privacy-proxy quality (re-requests the stream); embed quality is a best-effort hint.
  // Persisted per device; defaults to the 1080p remux tier - full quality is the whole
  // point of the upgrade, and a failed remux falls back to progressive server-side.
  const [proxyQuality, setProxyQuality] = useState<StreamQuality>(() => {
    try { return (localStorage.getItem(PROXY_QUALITY_KEY) as StreamQuality) || '1080' } catch { return '1080' }
  })
  const pickProxyQuality = (q: StreamQuality) => {
    try { localStorage.setItem(PROXY_QUALITY_KEY, q) } catch { /* quota */ }
    // Entering/leaving a remux tier swaps the src; carry the position across via the
    // remux offset (into remux) or posRef + startLocalAt (out of it). Remux targets then
    // refine to the exact keyframe so A/V stay in sync.
    remuxOffsetRef.current = posRef.current
    setRemuxStart(posRef.current)
    setProxyQuality(q)
    if (REMUX_QUALITIES.has(q) && posRef.current > 0.25) requestRemuxSeek(posRef.current, q)
  }
  const [embedLevels, setEmbedLevels] = useState<string[]>([])
  const [embedQuality, setEmbedQuality] = useState('auto')
  // If the privacy proxy can't produce a stream, fall back to the embed so playback
  // still works rather than showing a dead player.
  const [proxyFailed, setProxyFailed] = useState(false)
  // Last-resort tier: the stream resolve failed completely (both InnerTube and yt-dlp),
  // so the server kicked off an offline download instead of erroring out — see the /stream
  // 202 "preparing" response. While this is set we show a spinner rather than falling
  // through to the iframe embed; once the download lands we switch straight to the file.
  const [preparingKind, setPreparingKind] = useState<'audio' | 'video' | null>(null)
  const [fallbackReadyKind, setFallbackReadyKind] = useState<'audio' | 'video' | null>(null)
  useEffect(() => { setPreparingKind(null); setFallbackReadyKind(null) }, [videoId])

  const localSrc = localKind ? fileUrl(videoId, localKind) : null
  // Audio-only streams just the audio through our server, with the thumbnail as poster.
  const onlineAudio = audioOnly && !localKind && !proxyFailed
  const usingProxy = privacyProxy && !localKind && !proxyFailed && !onlineAudio
  // Remux tiers (1080/1440/4K): the server pipes a live ffmpeg remux, which has no
  // byte-range seeking - the element plays from an OFFSET and every seek swaps the src
  // to a new offset. `remuxStart` is that offset (state so a change remounts the src);
  // `remuxOffsetRef` mirrors it for the position math in read()/persist.
  const remux = usingProxy && REMUX_QUALITIES.has(proxyQuality)
  const [remuxStart, setRemuxStart] = useState(() => Math.max(0, resumeSec))
  const remuxOffsetRef = useRef(Math.max(0, resumeSec))
  // Remux seeks go through the align endpoint first: starting both tracks on the exact
  // video keyframe is what keeps A/V in sync (a bare offset snaps video back to the
  // previous keyframe while audio lands exactly, drifting them by up to a GOP). The
  // position adopts the aligned timestamp - that's where content truly resumes.
  const remuxSeekGen = useRef(0)
  const requestRemuxSeek = (sec: number, quality: StreamQuality = proxyQuality) => {
    const gen = ++remuxSeekGen.current
    setBuffering(true)
    remuxOffsetRef.current = sec
    posRef.current = sec
    setPosition(sec)
    void fetch(`/api/youtube/stream/${videoId}/align?t=${sec.toFixed(3)}&q=${quality}`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null)).catch(() => null)
      .then((d: { start?: number } | null) => {
        if (gen !== remuxSeekGen.current) return   // a newer seek superseded this one
        const aligned = d && typeof d.start === 'number' && Number.isFinite(d.start) ? Math.max(0, d.start) : sec
        remuxOffsetRef.current = aligned
        posRef.current = aligned
        setPosition(aligned)
        setRemuxStart(aligned)
      })
  }
  // A resume (initial offset > 0) is a seek too - align it before real playback settles.
  const remuxInitAligned = useRef(false)
  useEffect(() => {
    if (!remux || remuxInitAligned.current) return
    remuxInitAligned.current = true
    if (remuxOffsetRef.current > 0.25) requestRemuxSeek(remuxOffsetRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remux])
  // Native <video>/<audio> source: an offline file, the privacy proxy, audio-only, or (once
  // the last-resort download lands) the freshly-saved offline file.
  const nativeVideoSrc =
    localKind === 'video' ? localSrc
    : fallbackReadyKind === 'video' ? fileUrl(videoId, 'video')
    : usingProxy ? proxyStreamUrl(videoId, 'video', proxyQuality, remux ? remuxStart : undefined)
    : null
  const nativeAudioSrc =
    localKind === 'audio' ? localSrc
    : fallbackReadyKind === 'audio' ? fileUrl(videoId, 'audio')
    : onlineAudio ? proxyStreamUrl(videoId, 'audio')
    : null
  // Use the YouTube embed only when we have no native source to drive, and we're not busy
  // waiting on the last-resort download (that has its own "Preparing…" UI, not the embed).
  const useIframe = !nativeVideoSrc && !nativeAudioSrc && !preparingKind

  // This mount exists to satisfy a boost request made while still on the embed (the parent
  // flipped privacyProxy on, remounting us onto a native element): pop the slider open so
  // the user lands right on the control they reached for. Consumed once.
  useEffect(() => {
    if (autoOpenBoost && !useIframe) { setBoostOpen(true); onBoostOpenHandled?.() }
  }, [autoOpenBoost, useIframe]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the last-resort download until it's ready, then switch the native source over to it.
  useEffect(() => {
    if (!preparingKind) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const kind = preparingKind
    const poll = async () => {
      try {
        const status = await getDownloadStatus(videoId, kind)
        if (cancelled) return
        if (status === 'ready') { setPreparingKind(null); setFallbackReadyKind(kind); return }
        if (status === 'failed') { setPreparingKind(null); setProxyFailed(true); return }
      } catch { /* transient — keep polling */ }
      if (!cancelled) timer = setTimeout(poll, 4000)
    }
    timer = setTimeout(poll, 4000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [preparingKind, videoId])

  // Called from the native <video>/<audio> onError: check whether the stream genuinely died
  // (fall back to the embed, as before) or the server answered 202 "preparing" (start polling
  // for the last-resort download instead). Only fires on an actual playback error, so the
  // common "stream just works" case never pays for this extra request.
  async function handleStreamError(kind: 'audio' | 'video', src: string) {
    try {
      const res = await fetch(src, { credentials: 'include' })
      if (res.status === 202) { setPreparingKind(kind); return }
      try { await res.body?.cancel() } catch { /* already closed */ }
    } catch { /* noop */ }
    setProxyFailed(true)
  }

  // Reading position works against whichever backing player is active. The remux pipe
  // plays from an offset and can't report a total duration, so both are corrected here.
  const read = () => {
    const m = mediaRef.current, y = ytRef.current
    if (m) {
      const t = (m.currentTime || 0) + (remux ? remuxOffsetRef.current : 0)
      const d = remux ? (durationHintSec ?? 0) : (m.duration || 0)
      return { t, d, playing: !m.paused }
    }
    if (y?.getCurrentTime) { try { return { t: y.getCurrentTime() || 0, d: y.getDuration?.() || 0, playing: y.getPlayerState?.() === 1 } } catch { /* not ready */ } }
    return null
  }

  const seekTo = (sec: number) => {
    const m = mediaRef.current, y = ytRef.current
    if (m) {
      if (remux) {
        // The pipe isn't byte-seekable: re-request the stream from the new offset,
        // keyframe-aligned so audio and video start on the same timestamp.
        requestRemuxSeek(sec)
        return
      }
      try { m.currentTime = sec } catch { /* not seekable */ }
    }
    else if (y?.seekTo) { try { y.seekTo(sec, true) } catch { /* noop */ } }
  }

  // Kids time budget: the watch-state response carries the gate. When the budget runs
  // out mid-video, pause gently (once) instead of hard-cutting; a low-budget warning
  // fires once so "one more video" decisions are informed.
  const timeLimitHit = useRef(false)
  const timeWarned = useRef(false)
  const applyTimeGate = (gate: { allowed: boolean; reason?: string; remainingSec: number | null } | null) => {
    if (!gate) return
    if (!gate.allowed && !timeLimitHit.current) {
      timeLimitHit.current = true
      const m = mediaRef.current, y = ytRef.current
      if (m) { try { m.pause() } catch { /* noop */ } } else { try { y?.pauseVideo?.() } catch { /* noop */ } }
      toast.info(gate.reason === 'hours' ? 'Videos are paused for now. Come back during allowed hours.' : 'Video time is up for today.')
    } else if (gate.allowed && gate.remainingSec != null && gate.remainingSec <= 300 && !timeWarned.current) {
      timeWarned.current = true
      toast.info('About 5 minutes of video time left today.')
    }
  }

  const persist = (completed = false) => {
    const s = read(); if (!s) return
    if (s.t < 1 && !completed) return
    const done = completed || (s.d ? s.t >= s.d * 0.97 : false)
    void saveWatchState(videoId, s.t, done, videoMeta).then(applyTimeGate)
  }

  // No dependency array: the handle must close over the CURRENT remux/seek state (an
  // empty-deps handle froze the mount-time closure and broke remux seeking).
  useImperativeHandle(ref, () => ({
    seek: (sec: number) => {
      const m = mediaRef.current, y = ytRef.current
      if (m) {
        seekTo(sec)
        void m.play()?.catch(() => {})
      }
      else if (y?.seekTo) { try { y.seekTo(sec, true); y.playVideo?.() } catch { /* noop */ } }
      setPosition(sec)
    },
    togglePlay: () => {
      const m = mediaRef.current, y = ytRef.current
      if (m) { try { m.paused ? void m.play()?.catch(() => {}) : m.pause() } catch { /* noop */ } }
      else if (y) {
        try {
          // Optimistic, matching toggle(): the paused-poster cover must mount instantly.
          if (y.getPlayerState?.() === 1) { y.pauseVideo?.(); setPlaying(false) }
          else { y.playVideo?.(); setPlaying(true) }
        } catch { /* noop */ }
      }
    },
    pause: () => {
      const m = mediaRef.current, y = ytRef.current
      if (m) { try { m.pause() } catch { /* noop */ } } else { try { y?.pauseVideo?.() } catch { /* noop */ } }
    },
  }))

  // Online (embed only): drive the IFrame API. Skipped when a native source is active.
  useEffect(() => {
    if (!useIframe) return
    let cancelled = false
    setBuffering(true)
    void loadYTApi().then(YT => {
      if (cancelled || !frameRef.current) return
      const host = document.createElement('div')
      host.className = 'size-full'
      frameRef.current.appendChild(host)
      ytRef.current = new YT.Player(host, {
        videoId,
        playerVars: {
          autoplay: 1, start: Math.floor(resumeSec) || 0, rel: 0, modestbranding: 1, controls: 0, playsinline: 1,
          // Suppress YouTube's own chrome that bleeds through underneath our custom bar
          // even with controls:0 — info-card annotations (share/watch-later icons),
          // forced captions, the fullscreen button, and keyboard shortcuts.
          iv_load_policy: 3, cc_load_policy: 0, fs: 0, disablekb: 1,
        },
        events: {
          onReady: (e: any) => {
            try {
              e.target.playVideo?.(); setDuration(e.target.getDuration?.() || 0)
              e.target.setPlaybackRate?.(rate)
              e.target.setVolume?.(Math.round(volumeRef.current * 100))
              setEmbedLevels(e.target.getAvailableQualityLevels?.() ?? [])
              // Force the embed to OUR caption preference: Google's sticky captions-on
              // state otherwise wins and our chrome has no native toggle (controls: 0).
              enforceEmbedCc(e.target, ccOnRef.current)
            } catch { /* noop */ }
          },
          onPlaybackQualityChange: (e: any) => setEmbedQuality(e.data ?? 'auto'),
          onStateChange: (e: any) => {
            setPlaying(e.data === 1)
            setBuffering(e.data === 3) // 3 = BUFFERING
            if (e.data === 1 || e.data === 2) setBuffering(false)
            if (e.data === 1) { setStarted(true); setEndedUi(false) }
            // Re-enforce OUR caption preference every time playback (re)starts - YouTube
            // re-applies its sticky captions-on state at play, overriding the onReady set.
            if (e.data === 1) enforceEmbedCc(e.target, ccOnRef.current)
            if (e.data === YT.PlayerState?.ENDED) { setEndedUi(true); persist(true); endedWithSleep() }
          },
        },
      })
    })
    return () => { cancelled = true; try { ytRef.current?.destroy?.() } catch { /* noop */ }; ytRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, useIframe])

  // Poll position for the scrubber, periodic watch-state save, and SponsorBlock skips.
  useEffect(() => {
    const iv = setInterval(() => {
      const s = read(); if (!s) return
      setPosition(s.t); posRef.current = s.t; if (s.d) setDuration(s.d); setPlaying(s.playing)
      onTime?.(s.t); onPlaying?.(s.playing)

      // The embed only exposes its quality levels once playback has started; refresh
      // them here so the Quality menu isn't stuck showing just "Auto". (Best-effort:
      // YouTube may still ignore setPlaybackQuality and keep auto.)
      const y = ytRef.current
      if (y?.getAvailableQualityLevels) {
        const lv = y.getAvailableQualityLevels() as string[]
        if (lv?.length) setEmbedLevels(prev => (prev.length === lv.length && prev.every((x, i) => x === lv[i])) ? prev : lv)
      }

      // SponsorBlock: if we're inside a skippable segment, jump to its end.
      if (skipSegments?.length && s.playing) {
        const seg = skipSegments.find(g => s.t >= g.start && s.t < g.end - 0.3)
        if (seg && lastSkip.current !== `${seg.start}`) {
          lastSkip.current = `${seg.start}`
          seekTo(seg.end)
          setPosition(seg.end)
          onSkip?.(seg.category)
        }
      }

      const now = Date.now()
      if (s.playing && now - lastSave.current > 5000) { lastSave.current = now; persist() }
    }, 500)
    return () => { clearInterval(iv); persist() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, skipSegments])

  // Apply playback speed to whichever backend is active (and re-apply when it changes).
  useEffect(() => {
    const m = mediaRef.current, y = ytRef.current
    if (m) m.playbackRate = rate
    else if (y?.setPlaybackRate) { try { y.setPlaybackRate(rate) } catch { /* noop */ } }
  }, [rate, useIframe, proxyQuality])

  // Local/proxy media: restore position + speed once metadata is ready (also after a
  // quality switch reloads the element).
  function startLocalAt() {
    const el = mediaRef.current; if (!el) return
    if (!remux) {
      const target = Math.max(resumeSec, posRef.current)
      if (target > 1) { try { el.currentTime = target } catch { /* not seekable */ } }
    }
    // Remux streams already begin at the requested offset - seeking the element would
    // double-apply it (and the pipe isn't seekable anyway).
    el.playbackRate = rate
    el.volume = volumeRef.current
    void el.play()?.catch(() => {})
  }

  const toggle = () => {
    const m = mediaRef.current, y = ytRef.current
    if (m) { m.paused ? void m.play()?.catch(() => {}) : m.pause() }
    // Call the IFrame API methods *on* the player; pulling them off into a ternary
    // loses `this` and the postMessage silently throws, so play/pause would no-op.
    // Set `playing` optimistically too: the embed's state event arrives a beat later,
    // and the paused-poster cover must mount the INSTANT the user pauses so YouTube's
    // built-in pause overlays ("More videos", title bar) never get a frame to show.
    else if (y) {
      try {
        if (y.getPlayerState?.() === 1) { y.pauseVideo?.(); setPlaying(false) }
        else { y.playVideo?.(); setPlaying(true) }
      } catch { /* noop */ }
    }
  }
  const toggleMute = () => {
    const m = mediaRef.current, y = ytRef.current
    const next = !muted
    if (m) m.muted = next
    else if (y) { try { next ? y.mute?.() : y.unMute?.() } catch { /* noop */ } }
    setMuted(next)
  }
  // Volume (not just on/mute): persisted per device, applied to whichever backing
  // player is active. Kept in a ref too so the embed's onReady (created once) and
  // startLocalAt can apply the CURRENT value without stale closures.
  const [volume, setVolumeState] = useState(() => {
    try { const v = Number.parseFloat(localStorage.getItem('yt.volume') ?? '1'); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1 } catch { return 1 }
  })
  const volumeRef = useRef(volume)
  const setVolume = (v: number) => {
    const vol = Math.min(1, Math.max(0, v))
    volumeRef.current = vol
    setVolumeState(vol)
    try { localStorage.setItem('yt.volume', String(vol)) } catch { /* quota */ }
    const m = mediaRef.current, y = ytRef.current
    if (m) {
      m.volume = vol
      if (vol > 0 && m.muted) { m.muted = false; setMuted(false) }
    } else if (y) {
      try {
        y.setVolume?.(Math.round(vol * 100))
        if (vol > 0) { y.unMute?.(); setMuted(false) }
      } catch { /* noop */ }
    }
  }
  const { isFullscreen, fillMode, toggleFullscreen, toggleFillMode } = useZoomToFillFullscreen(mediaRef, wrapRef)
  const { boost, setBoost } = useAudioBoost(mediaRef)

  // ── Sleep timer ────────────────────────────────────────────────────────────────
  // Pause after N minutes (or at the end of this video). Survives navigation within the
  // player mount; a fresh video keeps a running timer, which is the point at bedtime.
  const [sleepMin, setSleepMin] = useState<number | null>(null)
  const [sleepEndOfVideo, setSleepEndOfVideo] = useState(false)
  const [sleepLeftSec, setSleepLeftSec] = useState<number | null>(null)
  const pauseNow = useCallback(() => {
    const m = mediaRef.current, y = ytRef.current
    if (m) { try { m.pause() } catch { /* noop */ } } else { try { y?.pauseVideo?.() } catch { /* noop */ } }
  }, [])
  useEffect(() => {
    if (sleepMin == null) { setSleepLeftSec(null); return }
    let left = sleepMin * 60
    setSleepLeftSec(left)
    const iv = setInterval(() => {
      left -= 1
      setSleepLeftSec(left)
      if (left <= 0) {
        clearInterval(iv)
        setSleepMin(null)
        pauseNow()
        toast.info('Sleep timer: paused')
      }
    }, 1000)
    return () => clearInterval(iv)
  }, [sleepMin, pauseNow])

  // "Stop after this video": swallow the ended signal so autoplay-next never fires, and
  // clear the arming. Read through a ref because the embed's ENDED handler is created
  // once, at mount, and would otherwise see the mount-time value forever.
  const sleepEndRef = useRef(sleepEndOfVideo)
  sleepEndRef.current = sleepEndOfVideo
  const endedWithSleep = useCallback(() => {
    if (!sleepEndRef.current) { onEnded?.(); return }
    setSleepEndOfVideo(false)
    toast.info('Sleep timer: stopped after this video')
  }, [onEnded])

  // ── Screen lock ────────────────────────────────────────────────────────────────
  // Locks touch input over the video (kids in the back seat, a phone in a pocket).
  // Everything on the surface is swallowed until the small unlock chip is tapped.
  const [screenLocked, setScreenLocked] = useState(false)

  // ── Stable volume ──────────────────────────────────────────────────────────────
  // Loudness levelling across mixed sources. Needs the Web-Audio graph, so it only
  // applies on native playback (the cross-origin embed is untouchable, same as boost).
  const [stableVolume, setStableVolumeState] = useState(() => {
    try { return localStorage.getItem('videos.stableVolume') === '1' } catch { return false }
  })
  const setStableVolume = (on: boolean) => {
    setStableVolumeState(on)
    try { localStorage.setItem('videos.stableVolume', on ? '1' : '0') } catch { /* quota */ }
    const el = mediaRef.current
    if (el) ensureMediaGraph(el)   // build the chain on this user gesture if needed
    applyDsp({ stableVolume: on })
  }
  // Re-assert on mount/source change: applyDsp is global, but a freshly-built graph for
  // this element needs the setting pushed once it exists.
  useEffect(() => {
    if (!stableVolume) return
    const el = mediaRef.current
    if (el) { ensureMediaGraph(el); applyDsp({ stableVolume: true }) }
  }, [stableVolume, nativeVideoSrc, nativeAudioSrc])

  // ── Ambient color ──────────────────────────────────────────────────────────────
  // Sampled from the live frame on native playback and handed to the page, which tints
  // its cinema backdrop with it. The embed's pixels aren't readable, so it stays null.
  const ambient = useVideoAmbient(mediaRef, !!nativeVideoSrc && !!onAmbientColor)
  const onAmbientRef = useRef(onAmbientColor)
  onAmbientRef.current = onAmbientColor
  useEffect(() => { onAmbientRef.current?.(ambient) }, [ambient])
  // Leaving native playback (or unmounting) hands the page back its thumbnail palette.
  useEffect(() => () => { onAmbientRef.current?.(null) }, [])

  // ── Touch gestures ─────────────────────────────────────────────────────────────
  // Double-tap sides to seek ±10s, press-and-hold for 2x. The held rate is transient:
  // it restores the channel's remembered rate on release (never overwrites it).
  const rateBeforeHold = useRef(1)
  const gestures = useVideoGestures({
    seekBy: (delta) => {
      const target = Math.max(0, Math.min(posRef.current + delta, duration || Infinity))
      seekTo(target)
      setPosition(target)
    },
    setHold: (on) => {
      if (on) { rateBeforeHold.current = rate; setRateState(2) }
      else setRateState(rateBeforeHold.current)
    },
  }, !screenLocked)
  // Live spectrum for the audio-only EQ overlay (shares the boost's Web-Audio graph).
  const getAnalyser = useMediaAnalyser(mediaRef, !nativeVideoSrc && !!nativeAudioSrc)

  // PiP state sync: reflect browser-driven exits (e.g. the PiP window's own close
  // button) back into our icon. Native <video> only — no PiP-eligible element while
  // still on the iframe embed or in audio-only mode.
  useEffect(() => {
    if (!nativeVideoSrc) return
    const el = mediaRef.current; if (!el) return
    const onEnter = () => setPipActive(true)
    const onLeave = () => setPipActive(false)
    el.addEventListener('enterpictureinpicture', onEnter)
    el.addEventListener('leavepictureinpicture', onLeave)
    return () => { el.removeEventListener('enterpictureinpicture', onEnter); el.removeEventListener('leavepictureinpicture', onLeave) }
  }, [nativeVideoSrc])

  // True OS-level Picture-in-Picture. Works directly on the native <video> element when
  // one's already active (offline file, or the privacy-proxy stream). The plain YouTube
  // iframe embed has no PiP-eligible element to hand off (and Document PiP can't host
  // it — YouTube's embedded player rejects that context outright with an onError 153,
  // confirmed by testing; see YoutubeMiniBar's togglePip for the same finding), so
  // requesting PiP while still on the embed instead asks the parent to switch this video
  // onto the same real-<video> proxy stream the "Private stream" toggle already uses,
  // and fires PiP itself once that stream is actually playing (see onPlaying below).
  const togglePip = () => {
    const el = mediaRef.current
    if (el instanceof HTMLVideoElement) {
      if (document.pictureInPictureElement === el) void document.exitPictureInPicture().catch(() => {})
      else void el.requestPictureInPicture().catch(() => {})
      return
    }
    onNeedsProxyForPip?.()
  }

  // Apply an embed quality level (best-effort; modern YouTube often ignores this and
  // keeps auto, but the API still accepts the hint).
  const pickEmbedQuality = (level: string) => {
    const y = ytRef.current
    try { level === 'auto' ? y?.setPlaybackQuality?.('default') : y?.setPlaybackQuality?.(level) } catch { /* noop */ }
    setEmbedQuality(level); setMenu(null)
  }

  // Scrub bar: press/drag anywhere on it to seek, hover to preview a storyboard frame at
  // that timestamp. Storyboards are fetched lazily (only once the bar is actually
  // hovered) and cached for the session — a scrub, quality-switch remount, etc. never
  // re-fetches once the first hover has warmed the query.
  const scrubRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [hoverRatio, setHoverRatio] = useState<number | null>(null)
  const [wantStoryboard, setWantStoryboard] = useState(false)

  const { data: storyboardLevels } = useQuery({
    queryKey: ['yt-storyboards', videoId],
    queryFn: () => getStoryboards(videoId),
    enabled: wantStoryboard && !localKind,
    staleTime: Infinity,
  })
  const storyboardLevel = useMemo(() => storyboardLevels?.length ? pickStoryboardLevel(storyboardLevels) : null, [storyboardLevels])

  const ratioFromClientX = (clientX: number) => {
    const rect = scrubRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }
  const seekToRatio = (ratio: number) => {
    const sec = ratio * (duration || 0)
    seekTo(sec)
    setPosition(sec)
  }
  const onScrubDown = (e: React.MouseEvent<HTMLDivElement>) => { seekToRatio(ratioFromClientX(e.clientX)); setDragging(true) }
  const onScrubMove = (e: React.MouseEvent<HTMLDivElement>) => { setHoverRatio(ratioFromClientX(e.clientX)); setWantStoryboard(true) }
  const onScrubLeave = () => { if (!dragging) setHoverRatio(null) }

  // Dragging can carry the pointer outside the (thin, h-1) bar itself — track window-level
  // moves/up while a drag is active so the seek keeps following the cursor.
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => { const r = ratioFromClientX(e.clientX); seekToRatio(r); setHoverRatio(r) }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, duration])

  const pct = duration ? Math.min(100, (position / duration) * 100) : 0

  // Scrubber tick marks for each SponsorBlock segment.
  const segMarks = useMemo(() => {
    if (!skipSegments?.length || !duration) return []
    return skipSegments.map(g => ({ left: (g.start / duration) * 100, width: Math.max(0.5, ((g.end - g.start) / duration) * 100), category: g.category }))
  }, [skipSegments, duration])

  // Chapter notches + the title of the chapter currently playing.
  const chapterMarks = useMemo(() => {
    if (!chapters?.length || !duration) return []
    return chapters.filter(ch => ch.start > 0).map(ch => ({ left: (ch.start / duration) * 100, title: ch.title }))
  }, [chapters, duration])
  const currentChapter = useMemo(() => {
    if (!chapters?.length) return null
    const i = activeChapter(chapters, position)
    return i >= 0 ? chapters[i]!.title : null
  }, [chapters, position])

  // Most-replayed heat curve under the scrubber: normalized intensities → one SVG
  // polyline over the bar's width. Drawn only when YouTube actually has heat data.
  const heatPath = useMemo(() => {
    if (!heatMarkers?.length) return null
    const max = Math.max(...heatMarkers.map(m => m.intensity))
    if (max <= 0) return null
    const span = heatMarkers[heatMarkers.length - 1]!.startMs + (heatMarkers[heatMarkers.length - 1]!.durationMs || 1)
    if (span <= 0) return null
    const pts = heatMarkers.map(m => {
      const x = (m.startMs / span) * 100
      const y = 100 - (m.intensity / max) * 100
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    // Close the shape along the baseline so it fills as an area under the curve.
    return `0,100 ${pts.join(' ')} 100,100`
  }, [heatMarkers])

  // PiP is offered whenever there's real video content to show — including the iframe
  // embed, via the proxy-switch in togglePip above — but not in audio-only mode (just a
  // static poster behind a hidden <audio>, nothing to put in a video PiP window).
  const showPip = typeof document !== 'undefined' && document.pictureInPictureEnabled && !nativeAudioSrc

  // What the Quality row should show + whether it's interactive in this mode.
  const qualityLabel = usingProxy
    ? (PROXY_QUALITIES.find(q => q.value === proxyQuality)?.label ?? 'Auto')
    : useIframe ? (YT_QUALITY_LABEL[embedQuality] ?? 'Auto') : null

  // Mid-watch pause on the embed: KEEP the paused frame (no poster swap) and mask
  // YouTube's paused chrome instead - top scrim over its title bar, our control bar
  // forced visible over its bottom row.
  const pausedFrame = useIframe && !playing && !buffering && started && !endedUi

  return (
    <div ref={wrapRef} onMouseLeave={() => { setMenu(null); setBoostOpen(false) }}
      className={cn('group relative overflow-hidden bg-black', !frameless && 'rounded-card',
        aspect === 'short' ? 'size-full' : 'aspect-video w-full')}>
      <div ref={frameRef} className="size-full">
        {nativeVideoSrc ? (
          <video ref={mediaRef as React.RefObject<HTMLVideoElement>} src={nativeVideoSrc} className="size-full"
            onLoadStart={() => setBuffering(true)} onWaiting={() => setBuffering(true)} onStalled={() => setBuffering(true)}
            onLoadedMetadata={startLocalAt} onCanPlay={() => setBuffering(false)}
            onPlaying={() => {
              setBuffering(false); setPlaying(true)
              if (autoRequestPip) { onPipRequestHandled?.(); const el = mediaRef.current; if (el instanceof HTMLVideoElement) void el.requestPictureInPicture?.().catch(() => {}) }
            }}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onError={() => { if (privacyProxy && !localKind) void handleStreamError('video', nativeVideoSrc) }}
            onEnded={() => {
              // A remux pipe that dies mid-stream (network blip, rotated upstream URL)
              // ends the element early - that's a stall, not the end of the video.
              // Resume from the current position with a fresh request instead of firing
              // autoplay-next; the server invalidates + re-resolves the URLs on retry.
              if (remux && durationHintSec && (remuxOffsetRef.current + (mediaRef.current?.currentTime ?? 0)) < durationHintSec - 8) {
                seekTo(remuxOffsetRef.current + (mediaRef.current?.currentTime ?? 0))
                return
              }
              persist(true); endedWithSleep()
            }}>
            {/* Subtitles for the native paths (private stream / offline): the transcript VTT
                as a real track, shown only when our CC toggle is on. */}
            <track kind="subtitles" srcLang="en" label="Subtitles" src={`/api/youtube/transcript/${videoId}`} default={ccOn} />
          </video>
        ) : nativeAudioSrc ? (
          <div className="relative flex size-full items-center justify-center bg-black">
            {/* Keep the video's thumbnail as a poster while only the audio plays - in BOTH
                the streamed and local-save audio modes. Try maxres first via overrideSrc,
                since it 404s for many videos (that was the "blank player"); VideoThumb then
                falls back to the always-present hqdefault, and only then to its icon. */}
            <VideoThumb videoId={videoId} title="" quality="hq"
              overrideSrc={ytImageProxy(thumbUrl(videoId, 'maxres'))}
              className="size-full object-cover opacity-90" />
            <div className="absolute inset-0 bg-black/30" />
            {/* Audio-reactive EQ over the poster's lower half (same visualizer as the music
                mini-players), kept clear of the bottom control bar. */}
            {/* design-ok(hex-in-tsx): canvas fillStyle cannot consume CSS vars; hues match the Videos accent (--yt-accent-fg/--yt-accent) */}
            <div className="pointer-events-none absolute inset-x-0 bottom-14 top-1/2">
              <AudioVisualizer variant={stripVariant} mode="strip" active={playing} getAnalyser={getAnalyser}
                palette={VIDEO_AUDIO_PALETTE} opacity={0.7} fade />
            </div>
            {/* design-ok(raw-palette-semantic) design-ok(backdrop-blur-outside-chrome): status badge on a theme-invariant chip floating over the video surface */}
            <span className="absolute right-3 top-3 z-30 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-sky-300 opacity-0 backdrop-blur transition group-hover:opacity-100">
              <Music className="size-3.5" /> Audio only
            </span>
            <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={nativeAudioSrc} className="hidden"
              onLoadStart={() => setBuffering(true)} onWaiting={() => setBuffering(true)}
              onLoadedMetadata={startLocalAt} onCanPlay={() => setBuffering(false)} onPlaying={() => setBuffering(false)}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
              onError={() => { if (onlineAudio) void handleStreamError('audio', nativeAudioSrc) }}
              onEnded={() => { persist(true); endedWithSleep() }} />
          </div>
        ) : null}
      </div>

      {/* Privacy badge when streaming through our proxy */}
      {usingProxy && (
        // design-ok(raw-palette-semantic) design-ok(backdrop-blur-outside-chrome): status badge on a theme-invariant chip floating over the video surface
        <div className="absolute left-3 top-3 z-30 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 opacity-0 backdrop-blur transition group-hover:opacity-100">
          <ShieldCheck className="size-3.5" /> Private stream
        </div>
      )}

      {/* Buffering / loading spinner covers the dead time while the privacy proxy
          resolves a stream (several seconds) or the embed/native player is loading. Also
          covers the last-resort "preparing" wait (both fast paths failed; an offline
          download was kicked off server-side and we're polling for it to land). */}
      {(buffering || preparingKind) && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/20">
          <Spinner className="size-10 text-white/90" />
          {preparingKind
            ? <span className="text-xs font-medium text-white/80">Preparing video…</span>
            : usingProxy && <span className="text-xs font-medium text-white/80">Starting private stream…</span>}
        </div>
      )}

      {/* Paused-frame masks: near-opaque bands over the zones where the embed paints its
          paused chrome (title bar up top; share/watch-later/"More videos"/logo along the
          bottom) - the frame itself stays visible in between. */}
      {pausedFrame && (
        <>
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-20 h-28 bg-gradient-to-b from-black via-black/90 to-transparent" />
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-36 bg-gradient-to-t from-black via-black/95 to-transparent" />
        </>
      )}

      {/* Custom control bar. pointer-events are disabled while it's hidden so the
          full-surface toggle layer below handles taps everywhere; on hover the bar
          becomes interactive so its scrubber + buttons work. Forced visible while a
          started embed is paused, so it masks YouTube's own paused bottom chrome. */}
      <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 z-30 translate-y-2 bg-gradient-to-t from-black/80 to-transparent px-4 pb-3 pt-8 opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100 group-hover:pointer-events-auto',
        pausedFrame && 'pointer-events-auto translate-y-0 from-black/90 opacity-100')}>
        <div ref={scrubRef} onMouseDown={onScrubDown} onMouseMove={onScrubMove} onMouseLeave={onScrubLeave}
          className="relative mb-3 h-1 cursor-pointer rounded-full bg-white/25">
          {/* Most replayed: the rewatch-intensity curve, sitting just above the bar. */}
          {heatPath && (
            <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none"
              className="pointer-events-none absolute inset-x-0 bottom-full mb-0.5 h-4 w-full overflow-visible">
              <polyline points={heatPath} className="fill-white/25 stroke-white/50" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          {/* SponsorBlock segment markers */}
          {segMarks.map((s, i) => (
            // design-ok(raw-palette-semantic): SponsorBlock warning marks on the scrubber over the video surface
            <span key={i} className="absolute top-0 h-full rounded-full bg-amber-400/80"
              style={{ left: `${s.left}%`, width: `${s.width}%` }} title={`SponsorBlock: ${s.category}`} />
          ))}
          {/* Chapter notches */}
          {chapterMarks.map((ch, i) => (
            <span key={i} className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/70" style={{ left: `${ch.left}%` }} title={ch.title} />
          ))}
          <div className="relative h-full rounded-full bg-[var(--yt-accent)]" style={{ width: `${pct}%` }}>
            <span className="absolute -right-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full bg-[var(--yt-accent)]" />
          </div>
          {/* Trickplay: sprite-sheet frame preview at the hovered timestamp */}
          {hoverRatio != null && storyboardLevel && duration > 0 && (
            <StoryboardPreview level={storyboardLevel} sec={hoverRatio * duration} ratio={hoverRatio} />
          )}
        </div>
        <div className="flex items-center gap-4 text-white">
          <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 fill-current" />}
          </button>
          {/* Mute + a hover-expanding volume slider (the mute-only toggle wasn't enough). */}
          <div className="group/vol flex items-center">
            <button onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
              {muted || volume === 0 ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </button>
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
              onChange={e => setVolume(Number(e.target.value))} aria-label="Volume"
              className="ml-0 w-0 cursor-pointer opacity-0 transition-all duration-200 accent-[var(--yt-accent)] group-hover/vol:ml-2 group-hover/vol:w-20 group-hover/vol:opacity-100" />
          </div>
          <span className="text-xs tabular-nums text-white/80">{fmtClock(position)} / {fmtClock(duration)}</span>
          {currentChapter && <span className="hidden truncate text-xs font-medium text-white/70 sm:block max-w-[40%]">· {currentChapter}</span>}
          <div className="flex-1" />

          {/* Captions: OUR toggle (persisted, default off) - the embed otherwise honors
              Google's sticky captions-on state with no way back from our chrome. */}
          <button onClick={toggleCc} aria-label={ccOn ? 'Turn captions off' : 'Turn captions on'}
            title={ccOn ? 'Captions on' : 'Captions off'}
            className={cn('transition', ccOn && 'text-[var(--yt-accent-fg)]')}>
            <Captions className="size-5" />
          </button>

          {/* Settings: playback speed + quality + playback modes */}
          <div className="relative">
            <button onClick={() => setMenu(m => (m ? null : 'main'))} aria-label="Settings"
              className={cn('flex items-center gap-1.5 transition', menu && 'text-[var(--yt-accent-fg)]')}>
              {rate !== 1 && <span className="text-xs font-bold tabular-nums">{rate}×</span>}
              <Settings className={cn('size-5 transition', menu === 'main' && 'rotate-45')} />
            </button>

            {menu && (
              // design-ok(raw-palette-semantic) design-ok(backdrop-blur-outside-chrome): theme-invariant dark settings menu floating over the video surface
              <div className="absolute bottom-full right-0 mb-3 w-52 overflow-hidden rounded-card border border-white/10 bg-zinc-900/95 text-sm text-white shadow-xl backdrop-blur">
                {menu === 'main' && (
                  <>
                    <MenuRow label="Playback speed" value={rate === 1 ? 'Normal' : `${rate}×`} onClick={() => setMenu('speed')} />
                    {qualityLabel != null && <MenuRow label="Quality" value={qualityLabel} onClick={() => setMenu('quality')} />}
                    <MenuRow label="Sleep timer"
                      value={sleepLeftSec != null ? fmtClock(sleepLeftSec) : sleepEndOfVideo ? 'End of video' : 'Off'}
                      onClick={() => setMenu('sleep')} />
                    {/* Stable volume + screen lock need a real element / touch surface:
                        Web Audio can't reach the cross-origin embed, same as boost. */}
                    {!useIframe && (
                      <OptionRow label="Stable volume" active={stableVolume}
                        onClick={() => setStableVolume(!stableVolume)} />
                    )}
                    <OptionRow label="Lock screen" active={screenLocked}
                      onClick={() => { setScreenLocked(true); setMenu(null) }} />
                    {/* Playback modes live IN the player (Plex-style), not in page chrome. */}
                    {onTogglePrivacy && (
                      <OptionRow label="Private stream" active={privacyProxy}
                        onClick={() => { onTogglePrivacy(); setMenu(null) }} />
                    )}
                    {onToggleAudioOnly && (
                      <OptionRow label="Audio only" active={audioOnly}
                        onClick={() => { onToggleAudioOnly(); setMenu(null) }} />
                    )}
                  </>
                )}
                {menu === 'speed' && (
                  <Submenu title="Playback speed" onBack={() => setMenu('main')}>
                    {SPEEDS.map(s => (
                      <OptionRow key={s} label={s === 1 ? 'Normal' : `${s}×`} active={rate === s}
                        onClick={() => { setRate(s); setMenu(null) }} />
                    ))}
                  </Submenu>
                )}
                {menu === 'sleep' && (
                  <Submenu title="Sleep timer" onBack={() => setMenu('main')}>
                    <OptionRow label="Off" active={sleepMin == null && !sleepEndOfVideo}
                      onClick={() => { setSleepMin(null); setSleepEndOfVideo(false); setMenu(null) }} />
                    {[10, 20, 30, 45, 60].map(m => (
                      <OptionRow key={m} label={`${m} minutes`} active={sleepMin === m}
                        onClick={() => { setSleepEndOfVideo(false); setSleepMin(m); setMenu(null) }} />
                    ))}
                    <OptionRow label="End of video" active={sleepEndOfVideo}
                      onClick={() => { setSleepMin(null); setSleepEndOfVideo(true); setMenu(null) }} />
                  </Submenu>
                )}
                {menu === 'quality' && (
                  <Submenu title="Quality" onBack={() => setMenu('main')}>
                    {usingProxy
                      ? PROXY_QUALITIES.map(q => (
                          <OptionRow key={q.value} label={q.label} active={proxyQuality === q.value}
                            onClick={() => { pickProxyQuality(q.value); setMenu(null) }} />
                        ))
                      : (
                        <>
                          <OptionRow label="Auto" active={embedQuality === 'auto'} onClick={() => pickEmbedQuality('auto')} />
                          {embedLevels.filter(l => l !== 'auto').map(l => (
                            <OptionRow key={l} label={YT_QUALITY_LABEL[l] ?? l} active={embedQuality === l} onClick={() => pickEmbedQuality(l)} />
                          ))}
                        </>
                      )}
                  </Submenu>
                )}
              </div>
            )}
          </div>

          {/* Audio boost: amplify quiet clips past 100%. Needs a real <video>/<audio>
              element to tap — Web Audio can't reach the iframe embed. On the embed the
              button is still shown but hands off to the privacy stream first (like PiP),
              so it's always discoverable rather than silently absent. */}
          {(!useIframe || onNeedsProxyForBoost) && (
            <div className="relative">
              <button onClick={() => (useIframe ? onNeedsProxyForBoost?.() : setBoostOpen(o => !o))}
                aria-label="Boost volume" title={useIframe ? 'Boost volume (switches to the privacy stream)' : 'Boost volume'}
                className={cn('flex items-center gap-1.5 transition', boost > 1 && 'text-[var(--yt-accent-fg)]')}>
                {boost > 1 && <span className="text-xs font-bold tabular-nums">{boost.toFixed(1)}×</span>}
                <Zap className="size-5" />
              </button>
              {boostOpen && !useIframe && (
                // design-ok(raw-palette-semantic) design-ok(backdrop-blur-outside-chrome): theme-invariant dark popover floating over the video surface
                <div className="absolute bottom-full right-0 mb-3 w-40 rounded-card border border-white/10 bg-zinc-900/95 p-3 text-white shadow-xl backdrop-blur">
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="font-semibold">Boost</span>
                    <span className="tabular-nums text-white/60">{boost.toFixed(1)}×</span>
                  </div>
                  <input type="range" min={1} max={4} step={0.1} value={boost}
                    onChange={e => setBoost(Number(e.target.value))} className="w-full accent-[var(--yt-accent)]" />
                </div>
              )}
            </div>
          )}
          {showPip && (
            <button onClick={togglePip} aria-label={pipActive ? 'Exit picture-in-picture' : 'Picture-in-picture'} title="Picture-in-picture"
              className={cn(pipActive && 'text-[var(--yt-accent-fg)]')}>
              <PictureInPicture className="size-5" />
            </button>
          )}
          {isFullscreen && (
            <button onClick={toggleFillMode} aria-label={fillMode === 'cover' ? 'Fit to screen' : 'Zoom to fill'} title={fillMode === 'cover' ? 'Fit to screen' : 'Zoom to fill'}>
              <Expand className={cn('size-5', fillMode === 'cover' && 'text-[var(--yt-accent-fg)]')} />
            </button>
          )}
          <button onClick={toggleFullscreen} aria-label="Fullscreen"><Maximize className="size-5" /></button>
        </div>
      </div>

      {/* Click anywhere on the video to toggle play/pause; shows a play badge when paused.
          Covers the whole surface (z-10) but sits below the control bar (z-30), which
          only captures pointer events on hover, so taps on the video always toggle.
          Touch gestures (double-tap sides = ±10s, press-and-hold = 2×) ride the same
          surface via pointer events; a gesture that fired swallows the click. */}
      <button onClick={() => { if (menu) { setMenu(null); return } if (gestures.isHolding()) return; toggle() }}
        aria-label={playing ? 'Pause' : 'Play'} {...gestures.handlers}
        className="absolute inset-0 z-10 flex items-center justify-center">
        {/* Idle embed BEFORE first play or AFTER the end: no frame worth keeping, so cover
            the iframe with our own poster to hide YouTube's cued/endscreen chrome ("More
            videos" wall, title bar, logo). A mid-watch pause keeps the frame (see the
            pausedFrame scrim + forced control bar instead). */}
        {useIframe && !playing && (!started || endedUi) && (
          <span aria-hidden className="absolute inset-0">
            <VideoThumb videoId={videoId} title="" quality="hq"
              overrideSrc={ytImageProxy(thumbUrl(videoId, 'maxres'))}
              className="size-full object-cover" />
            <span className="absolute inset-0 bg-black/40" />
          </span>
        )}
        {!playing && !buffering && (
          // design-ok(backdrop-blur-outside-chrome): play badge floats over the video surface
          <span className="relative flex size-16 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur">
            <Play className="size-7 fill-current" />
          </span>
        )}
      </button>

      {/* Gesture feedback: a transient chip for a double-tap seek, a persistent one while
          hold-to-2× is engaged. Keyed on the gesture id so repeats re-run the animation. */}
      {gestures.indicator && (
        // design-ok(raw-palette-semantic) design-ok(backdrop-blur-outside-chrome): transient gesture chip over the video surface
        <span key={gestures.indicator.id} aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 animate-in fade-in rounded-full bg-black/70 px-3 py-1.5 text-xs font-bold text-white backdrop-blur">
          {gestureIndicatorText(gestures.indicator)}
        </span>
      )}

      {/* Screen lock: swallow every touch on the surface until the unlock chip is tapped
          (kids in the back seat). Above the control bar, below nothing. */}
      {screenLocked && (
        <div className="absolute inset-0 z-40 flex items-start justify-center pt-4"
          onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          {/* design-ok(raw-palette-semantic) design-ok(backdrop-blur-outside-chrome) design-ok(hand-styled-button): unlock chip over the locked video surface */}
          <button onClick={() => setScreenLocked(false)}
            className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur transition hover:bg-black/85">
            <Lock className="size-3.5" /> Screen locked · tap to unlock
          </button>
        </div>
      )}
    </div>
  )
})

// A row in the settings menu that opens a sub-menu (shows current value).
function MenuRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    // design-ok(hand-styled-button) design-ok(glass-on-plain-bg): player settings row over the video surface (white-alpha styling)
    <button onClick={onClick} className="flex w-full items-center justify-between px-3 py-2.5 text-left transition hover:bg-white/10">
      <span>{label}</span>
      <span className="ml-3 truncate text-white/60">{value}</span>
    </button>
  )
}

function Submenu({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <>
      {/* design-ok(hand-styled-button) design-ok(glass-on-plain-bg): player settings row over the video surface (white-alpha styling) */}
      <button onClick={onBack} className="flex w-full items-center gap-2 border-b border-white/10 px-3 py-2 text-left font-semibold transition hover:bg-white/10">
        <span className="text-white/60">‹</span> {title}
      </button>
      <div className="max-h-56 overflow-y-auto py-1">{children}</div>
    </>
  )
}

// Trickplay preview: crops one frame out of a storyboard sprite sheet via CSS
// background-position, upscaled ~2× for legibility, floating above the scrub bar and
// clamped so it never overflows the player's edges.
function StoryboardPreview({ level, sec, ratio }: { level: StoryboardLevel; sec: number; ratio: number }) {
  const { sheetUrl, col, row } = frameForTime(level, sec)
  const scale = 2
  const w = level.width * scale
  const h = level.height * scale
  return (
    // design-ok(raw-palette-semantic) design-ok(backdrop-blur-outside-chrome): trickplay preview floats over the video surface
    <div className="pointer-events-none absolute bottom-full mb-2 overflow-hidden rounded-control border border-white/10 shadow-xl"
      style={{
        width: w, height: h,
        left: `clamp(${w / 2}px, ${ratio * 100}%, calc(100% - ${w / 2}px))`,
        transform: 'translateX(-50%)',
        backgroundImage: `url(${ytImageProxy(sheetUrl)})`,
        backgroundPosition: `-${col * w}px -${row * h}px`,
        backgroundSize: `${level.cols * w}px ${level.rows * h}px`,
      }}>
      <span className="absolute bottom-1 right-1.5 rounded bg-black/80 px-1 py-0.5 text-[10px] font-semibold tabular-nums text-white">{fmtClock(sec)}</span>
    </div>
  )
}

function OptionRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    // design-ok(hand-styled-button) design-ok(glass-on-plain-bg): player settings row over the video surface (white-alpha styling)
    <button onClick={onClick} className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-white/10">
      <Check className={cn('size-4 shrink-0', active ? 'text-[var(--yt-accent-fg)]' : 'opacity-0')} />
      {label}
    </button>
  )
}
