import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SkipForward, SkipBack, Headphones, Heart, Play, Loader2, ListVideo, PictureInPicture2, ExternalLink } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'
import { VideoPlayer } from '@/components/youtube/VideoPlayer'
import { useRadio } from '@/context/RadioContext'
import { useYoutubePlayback, type YtMiniTrack } from '@/context/YoutubePlaybackContext'
import { useMusicModeOptional } from '@/components/music/MusicLayout'
import { getStation, previewStationQueue, getOfflineVideoQueue, prefetchMedia, prefetchReady, addFavorite, stationToDj } from '@/lib/music/catalogApi'

interface WatchTrack { videoId: string; title: string; artist: string | null }

// Round bordered control button — matches the YouTube watch page's action row exactly.
const CTRL = 'grid size-9 place-items-center rounded-full border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

/** "Watch the station" — the station's tracklist played as music videos, back-to-back, wrapped in
 *  the Now-Playing look (accent hero + station chip + up-next). The video keeps its own transport;
 *  no DJ and no visualizer in video mode. Online streams via VideoPlayer; offline plays local files. */
export function MusicWatchStationPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const radio = useRadio()
  const pb = useYoutubePlayback()
  const offline = useMusicModeOptional() === 'offline'
  const watchPath = `/music/watch/${id}`
  // `current` = watch whatever's playing right now (any session, even a one-off song with no saved
  // station). It rides entirely on the hand-off below; a real station id also fetches station data.
  const isCurrent = id === 'current'

  const { data: stationData } = useQuery({ queryKey: ['music-station', id], queryFn: () => getStation(id), enabled: !!id && !isCurrent })
  const station = stationData?.station

  // Hand-off from a currently-playing AUDIO station to video: capture the exact queue, the current
  // song, and its position ONCE (before anything changes), so Watch resumes the same song mid-play.
  const [handoff] = useState(() => {
    const curTrack = radio.currentTrack ?? radio.queue[radio.index]
    const sameStation = radio.active && curTrack && (isCurrent || radio.station?.stationId === id || radio.station?.id === id)
    if (!sameStation) return null
    return {
      tracks: radio.queue.map(t => ({ videoId: t.videoId, title: t.title, artist: t.author })) as WatchTrack[],
      index: Math.max(0, radio.index),
      videoId: curTrack.videoId,
      sec: Math.floor(radio.positionSec),
    }
  })
  // Hand the sound to the video — stop the audio decks ONCE on mount so the two never play at
  // once. Guarded so it can't re-fire when radio state (and thus radio.stop's identity) changes —
  // otherwise "Listen instead" would start audio and this would immediately stop it again.
  const handedOff = useRef(false)
  useEffect(() => {
    if (handoff && !handedOff.current) { handedOff.current = true; radio.stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-expanding a video we docked into the mini-player: resume that exact song + position and
  // rebuild the rest of the queue fresh. (Radio hand-off wins if we're somehow also listening.)
  const [dockAdopt] = useState(() => {
    if (handoff || !pb.track || pb.track.expandTo !== watchPath) return null
    return { videoId: pb.track.videoId, title: pb.track.title, artist: pb.track.author, sec: Math.floor(pb.positionSec) }
  })
  const pbClearDock = pb.clearDock
  useEffect(() => { if (dockAdopt) pbClearDock() /* take the video back from the mini-player */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When not handing off, build a fresh queue (online sample, or the offline video-ready tracks).
  const { data: queueData, isLoading } = useQuery({
    queryKey: ['music-watch-queue', id, offline],
    queryFn: async (): Promise<WatchTrack[]> => offline
      ? (await getOfflineVideoQueue(id)).tracks.map(t => ({ videoId: t.videoId, title: t.title, artist: t.author || null }))
      : (await previewStationQueue(id, 20)).tracks.map(t => ({ videoId: t.videoId, title: t.title, artist: t.artist || null })),
    enabled: !!id && !handoff && !isCurrent,
  })
  const tracks = useMemo<WatchTrack[]>(() => {
    if (handoff) return handoff.tracks
    if (dockAdopt) {
      const lead: WatchTrack = { videoId: dockAdopt.videoId, title: dockAdopt.title, artist: dockAdopt.artist }
      return [lead, ...(queueData ?? []).filter(t => t.videoId !== dockAdopt.videoId)]
    }
    return queueData ?? []
  }, [handoff, dockAdopt, queueData])

  const [index, setIndex] = useState(handoff?.index ?? 0)
  const cur = tracks[index] ?? null

  // The resume position only applies to the exact hand-off / re-expand song; clears the moment you move.
  const [resume, setResume] = useState(
    handoff ? { videoId: handoff.videoId, sec: handoff.sec }
      : dockAdopt ? { videoId: dockAdopt.videoId, sec: dockAdopt.sec } : null,
  )
  const curResume = cur && resume && resume.videoId === cur.videoId ? resume.sec : 0

  // Track the video's live position so the reverse hand-off (→ audio) resumes at the same spot.
  const videoPos = useRef(curResume)

  const go = (next: number) => { setResume(null); videoPos.current = 0; setIndex(((next % tracks.length) + tracks.length) % (tracks.length || 1)) }
  const advance = () => go(index + 1)
  const back = () => go(index - 1)

  // The next videos to have on disk before we reach them (gapless advance).
  const upcoming = useMemo(() => {
    const ids: string[] = []
    for (let k = 1; k <= 2 && tracks.length; k++) { const t = tracks[(index + k) % tracks.length]; if (t && t.videoId !== cur?.videoId) ids.push(t.videoId) }
    return [...new Set(ids)]
  }, [tracks, index, cur?.videoId])

  // Prefetch upcoming videos (→ gapless advance) and the current song's audio (→ gapless "Listen
  // instead"). Offline already has everything local.
  useEffect(() => {
    if (offline || !cur) return
    void prefetchMedia(cur.videoId, 'audio')
    upcoming.forEach(vid => void prefetchMedia(vid, 'video', 480))
  }, [cur?.videoId, offline, upcoming])

  // Poll which of the current + upcoming videos are downloaded, so we can play from disk.
  const { data: readyVideos } = useQuery({
    queryKey: ['music-prefetch-ready-video', id, cur?.videoId],
    queryFn: () => prefetchReady([cur?.videoId, ...upcoming].filter(Boolean) as string[], 'video'),
    enabled: !offline && !!cur, refetchInterval: 3000,
  })
  const readyRef = useRef<Set<string>>(new Set())
  readyRef.current = useMemo(() => new Set(readyVideos ?? []), [readyVideos])
  // Decide local-vs-stream ONCE per track (freezing it avoids a mid-play source swap/restart).
  const [localVideo, setLocalVideo] = useState(false)
  useEffect(() => { setLocalVideo(offline || readyRef.current.has(cur?.videoId ?? '')) }, [cur?.videoId, offline])

  // ── Dock to the mini-player (YouTube-style) ──────────────────────────────────────
  // Keep a live mini-queue (current + up-next) so leaving the page hands the video to the docked
  // mini-player and it keeps playing. The reverse handoff (→ audio) and the mini's own teardown
  // must NOT dock, hence the flags.
  const playingRef = useRef(false)
  const leavingToAudio = useRef(false)
  const dockedRef = useRef(false)
  const pbDock = pb.dock
  const miniQueueRef = useRef<YtMiniTrack[]>([])
  miniQueueRef.current = cur
    ? tracks.slice(index).map((t, i) => ({
        videoId: t.videoId, title: t.title, author: t.artist,
        localKind: ((i === 0 ? localVideo : offline) ? 'video' : undefined) as 'video' | undefined,
        expandTo: watchPath,
      }))
    : []
  const dockNow = () => {
    if (!miniQueueRef.current[0]) return
    pbDock(miniQueueRef.current, 0, Math.floor(videoPos.current))
    dockedRef.current = true
  }
  // On navigate-away (not via "Listen instead"), hand the still-playing video to the mini-player.
  useEffect(() => () => {
    if (!leavingToAudio.current && !dockedRef.current && playingRef.current && videoPos.current > 1 && miniQueueRef.current[0]) {
      pbDock(miniQueueRef.current, 0, Math.floor(videoPos.current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const minimize = () => { dockNow(); navigate('/music') }

  // "Listen instead" picks up the *current* video as audio at its current position.
  const listen = () => {
    leavingToAudio.current = true
    if (cur) radio.playTrack({ videoId: cur.videoId, title: cur.title, author: cur.artist }, Math.floor(videoPos.current))
    else if (station) radio.start(stationToDj(station))
    navigate('/music/now-playing')
  }
  const favorite = async () => {
    if (!cur) return
    try { await addFavorite({ kind: 'song', refId: cur.videoId, title: cur.title, artist: cur.artist ?? undefined }); toast.success('Added to favorites') }
    catch { toast.error('Could not favorite') }
  }

  // Cold open of a real station still loads; "watch current" rides the live session (radio.station).
  if (!isCurrent && !station) return <div className="px-5 pt-10 text-sm text-muted-foreground">Loading…</div>
  const headerName = station?.name ?? radio.station?.label ?? 'Now Playing'
  const c1 = station ? stationToDj(station).color : (radio.station?.color ?? '#7c3aed')
  const c2 = station ? stationToDj(station).colorDark : (radio.station?.colorDark ?? '#4c1d95')
  const emoji = station ? stationToDj(station).emoji : (radio.station?.emoji ?? '📺')

  return (
    <div className="px-5 pb-8 pt-6">
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Player wrapped in the station's accent identity (mirrors Now Playing). */}
        <div className="min-w-0 space-y-4">
          <div className="relative overflow-hidden rounded-2xl border border-border/50 p-3 shadow-lg"
            style={{ background: `linear-gradient(135deg, ${c1}24, ${c2}0a 65%)` }}>
            <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full opacity-25 blur-3xl" style={{ background: c1 }} />
            <div className="relative">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-white/90 backdrop-blur">
                  <span>{emoji}</span> {headerName} · Video
                </span>
              </div>

              {isLoading ? (
                <div className="flex aspect-video items-center justify-center gap-2 rounded-xl bg-black/20 text-sm text-white/80"><Loader2 className="size-4 animate-spin" /> Lining up the videos…</div>
              ) : !cur ? (
                <div className="flex aspect-video items-center justify-center rounded-xl bg-black/20 px-6 text-center text-sm text-white/80">
                  {offline ? 'No videos downloaded for this station yet. Save it offline as Video or Both.' : 'Couldn’t build a video queue right now.'}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl ring-1 ring-white/10">
                  {/* Remount per track so the player cleanly loads the next video; it keeps its own
                      transport. resumeSec resumes the hand-off song at the same spot. */}
                  <VideoPlayer key={cur.videoId} videoId={cur.videoId} localKind={localVideo ? 'video' : undefined}
                    resumeSec={curResume} onTime={s => { videoPos.current = s }} onPlaying={p => { playingRef.current = p }} onEnded={advance} />
                </div>
              )}

              {cur && (
                <div className="relative mt-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <h1 className="truncate text-xl font-black tracking-tight">{cur.title}</h1>
                    {cur.artist && <p className="truncate text-sm text-muted-foreground">{cur.artist}</p>}
                  </div>
                  {/* Action row — same chrome + icons as the YouTube watch page. */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button className={CTRL} onClick={back} aria-label="Previous" title="Previous"><SkipBack className="size-4" /></button>
                    <button className={CTRL} onClick={advance} aria-label="Next" title="Next"><SkipForward className="size-4" /></button>
                    <button className={CTRL} onClick={favorite} aria-label="Favorite" title="Favorite"><Heart className="size-4" /></button>
                    <button onClick={listen} title="Listen instead — switch to audio at the same spot"
                      className="flex h-9 items-center gap-1.5 rounded-full border border-border/60 px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                      <Headphones className="size-4" /> Listen
                    </button>
                    <button className={CTRL} onClick={() => window.open(`https://www.youtube.com/watch?v=${cur.videoId}`, '_blank', 'noopener,noreferrer')} aria-label="Open on YouTube" title="Open on YouTube"><ExternalLink className="size-4" /></button>
                    <button className={CTRL} onClick={minimize} aria-label="Minimize to mini-player" title="Minimize — keep playing in the mini-player while you browse"><PictureInPicture2 className="size-4" /></button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Up next */}
        <div className="min-w-0">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><ListVideo className="size-4" /> Up next</p>
          <div className="space-y-1">
            {tracks.map((t, i) => (
              <button key={t.videoId + i} onClick={() => go(i)}
                className={cn('group flex w-full items-center gap-3 rounded-lg p-1.5 text-left transition hover:bg-accent/50', i === index && 'bg-accent')}>
                <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-muted">
                  <img src={proxyImg(`https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`)} alt="" loading="lazy"
                    className="size-full object-cover" onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
                  {i === index && <span className="absolute inset-0 grid place-items-center bg-black/40"><Play className="size-4 fill-white text-white" /></span>}
                </div>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{t.title}</p>{t.artist && <p className="truncate text-xs text-muted-foreground">{t.artist}</p>}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
