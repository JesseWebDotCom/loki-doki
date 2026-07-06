import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  HardDriveDownload, Download, Heart, Clock, Search, Smartphone, Mic, Check,
  ThumbsUp, ThumbsDown, Pin, SquareArrowOutDownLeft, MoreHorizontal, Circle, Square,
} from 'lucide-react'
import { ShieldCheck, Headphones, ExternalLink, Share2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { PageContainer } from '@/components/shared/PageContainer'
import { toast } from '@/lib/toast'
import { useYoutubeUI } from '@/components/youtube/YoutubeLayout'
import { VideoPlayer, type VideoPlayerHandle } from '@/components/youtube/VideoPlayer'
import { UpNextRow, watchHref } from '@/components/youtube/VideoCard'
import { AutoplayCountdown } from '@/components/youtube/AutoplayCountdown'
import { CreatePodcastDialog } from '@/components/youtube/CreatePodcastDialog'
import { useUnsubscribeConfirm } from '@/components/youtube/UnsubscribeDialog'
import { ChannelAvatar } from '@/components/youtube/media'
import { AddToPlaylistPill } from '@/components/youtube/AddToPlaylistButton'
import { useYtFeed, useSavedState } from '@/lib/youtube/useData'
import {
  getVideoMeta, summarize, getTranscriptText, getRelated, getSponsorSegments,
  getComments, getChapters, getVotes, addSubscription, deleteSubscription,
  startLiveRecord, stopLiveRecord, saveOffline,
  ytImageProxy, type VideoMeta, type VideoVotes,
} from '@/lib/youtube/api'
import { itToItem, isShort, type VideoItem } from '@/lib/youtube/types'
import { fmtViews } from '@/lib/youtube/format'
import { parseChapters } from '@/lib/youtube/chapters'
import { parseVtt, type TranscriptLine } from '@/lib/youtube/transcript'
import { toggleCollection, useCollection } from '@/lib/youtube/collections'
import { useDeArrow } from '@/lib/youtube/dearrow'
import { useYoutubePlayback, type YtMiniTrack } from '@/context/YoutubePlaybackContext'
import { acquireAudio, registerTransport } from '@/lib/mediaCoordinator'
import { useShareLink } from '@/hooks/use-share-link'

/** A feed/related item → a mini-player queue entry. */
const toMiniTrack = (v: VideoItem): YtMiniTrack => ({
  videoId: v.videoId, title: v.title, author: v.author ?? null,
  channelThumb: v.channelThumb ?? null, localKind: v.localKind, durationSec: v.durationSec ?? null,
})

type SideTab = 'transcript' | 'summary' | 'comments'

/** Compact like/dislike counts (1234 → "1.2K"). */
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return `${n}`
}

const PRIVACY_KEY = 'yt.privacy'
const AUDIO_KEY = 'yt.audioOnly'
const AUTOPLAY_COUNTDOWN_SEC = 8
const SB_LABELS: Record<string, string> = {
  sponsor: 'sponsor', selfpromo: 'self-promo', interaction: 'reminder',
  intro: 'intro', outro: 'outro', preview: 'recap', music_offtopic: 'non-music',
}

export function WatchPage() {
  const { videoId = '' } = useParams()
  const [params] = useSearchParams()
  const localKind = (params.get('k') as 'audio' | 'video' | null) ?? undefined
  const navigate = useNavigate()
  const pb = useYoutubePlayback()
  const playerRef = useRef<VideoPlayerHandle>(null)
  const [tab, setTab] = useState<SideTab>('transcript')
  const [autoplay, setAutoplay] = useState(true)
  // "Playing next in Ns" overlay shown instead of navigating immediately on end, so the
  // viewer gets a beat to cancel. Cleared on scrub-back/replay (see onTime/onPlaying below).
  const [countdown, setCountdown] = useState<{ secondsLeft: number; total: number } | null>(null)

  // ── Docked mini-player hand-off ────────────────────────────────────────────────
  // If this same video is currently playing in the docked mini-player (we got here by
  // tapping "expand"), resume from its position. Captured once, synchronously, so the
  // player starts at the right spot rather than the stale server position.
  const [adopt] = useState(() => (pb.track?.videoId === videoId ? Math.floor(pb.positionSec) : null))
  // Latest play state + position, mirrored into refs so the unmount handler (which runs
  // with stale closures) can hand the live values to the mini-player.
  const playingRef = useRef(false)
  const secRef = useRef(0)

  const { data: meta, isPending } = useQuery({ queryKey: ['yt-video', videoId], queryFn: () => getVideoMeta(videoId), enabled: !!videoId })
  const { items } = useYtFeed()
  const online = !localKind

  // Privacy proxy: stream through our server instead of the YouTube embed. Opt-in
  // (slower to start, currently caps at 720p) and remembered across the session.
  const [privacy, setPrivacy] = useState(() => localStorage.getItem(PRIVACY_KEY) === '1')
  const togglePrivacy = () => setPrivacy(p => { const n = !p; try { localStorage.setItem(PRIVACY_KEY, n ? '1' : '0') } catch { /* quota */ } return n })
  // Picture-in-Picture on the plain iframe embed needs a real <video> to hand off to,
  // which means switching onto the privacy-proxy stream (see VideoPlayer's togglePip).
  // Doesn't persist the toggle — this is "just get me PiP", not "always use the proxy".
  // VideoPlayer is keyed on `privacy` (remounts on change), so the pending-PiP intent is
  // threaded through as a prop rather than a ref, which a remount would wipe out.
  const [pipPending, setPipPending] = useState(false)
  const enablePrivacyForPip = () => { setPrivacy(true); setPipPending(true) }
  // Same story for audio boost: amplifying past 100% needs a real <video>/<audio> to tap,
  // which the iframe embed isn't — so a boost tap on the embed flips the privacy stream on
  // (session-only, not persisted) and threads a pending flag through the remount so the
  // boost slider opens on the freshly-mounted native player.
  const [boostPending, setBoostPending] = useState(false)
  const enablePrivacyForBoost = () => { setPrivacy(true); setBoostPending(true) }
  // Audio-only: stream just the audio (thumbnail stays as poster). Remembered per session.
  const [audioOnly, setAudioOnly] = useState(() => localStorage.getItem(AUDIO_KEY) === '1')
  const toggleAudioOnly = () => setAudioOnly(p => { const n = !p; try { localStorage.setItem(AUDIO_KEY, n ? '1' : '0') } catch { /* quota */ } return n })

  // Real "Up next": YouTube's own related videos (InnerTube), falling back to the feed
  // when offline or when related comes back empty.
  const { data: related = [] } = useQuery({ queryKey: ['yt-related', videoId], queryFn: () => getRelated(videoId), enabled: online && !!videoId })
  // SponsorBlock segments, auto-skipped + marked on the scrubber (online only).
  const { data: segments = [] } = useQuery({ queryKey: ['yt-sb', videoId], queryFn: () => getSponsorSegments(videoId), enabled: online && !!videoId })
  // Return YouTube Dislike: estimated like/dislike counts (online only).
  const { data: votes } = useQuery({ queryKey: ['yt-votes', videoId], queryFn: () => getVotes(videoId), enabled: online && !!videoId })
  // DeArrow: swap a clickbait title for the community one on the watch header too.
  // (The on/off switch lives in Settings → YouTube; this just reflects the global state.)
  const da = useDeArrow(videoId)

  // The card that linked here passes the channel's name/avatar (e.g. search results,
  // which aren't subscribed so the API can't supply them); used as a fallback.
  const navState = (useLocation().state ?? {}) as { title?: string | null; author?: string | null; channelThumb?: string | null }
  const feedItem = items.find(i => i.videoId === videoId)
  // A short opened in the full watch view: offer a jump back to the vertical feed.
  const isShortVid = online && !!feedItem && isShort(feedItem)
  const title = da?.title || meta?.title || feedItem?.title || navState.title || 'Video'
  const author = meta?.author ?? feedItem?.author ?? navState.author ?? null
  const channelThumb = meta?.channelThumb ?? feedItem?.channelThumb ?? navState.channelThumb ?? null
  const resumeSec = (adopt != null ? adopt : meta?.positionSec) ?? 0

  // Landing on a watch page means a full player owns playback, so stop any other audio source.
  useEffect(() => { acquireAudio('youtube'); if (pb.track) pb.clearDock() }, [videoId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Report to the shared now-playing snapshot so a device player bar reflects THIS watch
  // page (the mini-bar isn't in play here; the full player owns it). Cover = video thumb.
  useEffect(() => {
    if (!videoId) return
    const report = () => {
      void fetch('/api/pod/now-playing', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId, title, artist: author,
          cover: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
          positionSec: Math.round(secRef.current), durationSec: Math.round(meta?.durationSec ?? 0),
          playing: playingRef.current,
        }),
      }).catch(() => {})
    }
    report()
    const iv = setInterval(report, 4000)
    return () => clearInterval(iv)
  }, [videoId, title, author, meta?.durationSec])

  // Register transport controls so a remote (Tab5 player bar → server → dispatchTransport)
  // drives THIS full player; the mini-bar's registration is stale here (it's undocked).
  useEffect(() => registerTransport('youtube', {
    toggle: () => playerRef.current?.togglePlay(),
    seek: (s) => playerRef.current?.seek(s),
    prev: () => playerRef.current?.seek(0),
    next: () => { const nx = miniQueueRef.current[1]?.videoId; if (nx) navigate(`/youtube/watch/${nx}`) },
    stop: () => playerRef.current?.pause(),
  }), []) // eslint-disable-line react-hooks/exhaustive-deps


  const upNext = useMemo(() => {
    if (related.length) return related.map(itToItem).filter(i => i.videoId !== videoId).slice(0, 15)
    return items.filter(i => i.videoId !== videoId).slice(0, 15)
  }, [related, items, videoId])

  // The mini-player's queue = the current video followed by "Up next", so it can advance
  // (auto-play + skip buttons). Kept in a ref so the unmount hand-off uses the live value.
  const miniQueueRef = useRef<YtMiniTrack[]>([])
  miniQueueRef.current = [
    { videoId, title, author, channelThumb, localKind, durationSec: meta?.durationSec ?? null },
    ...upNext.map(toMiniTrack),
  ]

  // Navigating away mid-playback hands the queue to the docked mini-player. Uses refs so it
  // captures the video being watched at unmount, not the one this effect closed over.
  useEffect(() => () => {
    if (playingRef.current && secRef.current > 1 && miniQueueRef.current[0]?.videoId) {
      pb.dock(miniQueueRef.current, 0, secRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Chapters: creators usually list them as timestamped lines in the description (free to
  // parse). When that turns up nothing, fall back to YouTube's authoritative chapter list
  // (creator-set or auto) via InnerTube, only fetched in that case, so it's cheap.
  const descChapters = useMemo(() => parseChapters(meta?.description), [meta?.description])
  const { data: itChapters = [] } = useQuery({
    queryKey: ['yt-chapters', videoId],
    queryFn: () => getChapters(videoId),
    enabled: online && !!videoId && !!meta && descChapters.length === 0,
  })
  const chapters = descChapters.length ? descChapters : itChapters

  // Current playback second, drives the transcript's follow-along highlight.
  const [currentSec, setCurrentSec] = useState(0)
  const videoMeta = useMemo(() => ({
    title: meta?.title ?? feedItem?.title ?? navState.title ?? undefined,
    author, channelId: meta?.channelId ?? null, durationSec: meta?.durationSec ?? null,
  }), [meta?.title, meta?.channelId, meta?.durationSec, author, feedItem?.title, navState.title])

  function onEnded() {
    if (autoplay && upNext[0]) setCountdown({ secondsLeft: AUTOPLAY_COUNTDOWN_SEC, total: AUTOPLAY_COUNTDOWN_SEC })
  }

  // Ticks the "playing next" countdown down once a second and navigates when it hits 0.
  useEffect(() => {
    if (!countdown) return
    if (countdown.secondsLeft <= 0) {
      const nx = upNext[0]
      setCountdown(null)
      if (nx) navigate(watchHref(nx))
      return
    }
    const t = setTimeout(() => setCountdown(c => (c ? { ...c, secondsLeft: c.secondsLeft - 1 } : null)), 1000)
    return () => clearTimeout(t)
  }, [countdown, upNext, navigate])

  // Pop the video into the docked mini-player and leave the watch page. Forces the dock
  // (even if paused) so the button always does something; navigating away would otherwise
  // only hand off while playing.
  function minimize() {
    pb.dock(miniQueueRef.current, 0, secRef.current || currentSec)
    navigate('/youtube')
  }

  return (
    <PageContainer width="wide" className="grid grid-cols-1 gap-6 py-6 xl:grid-cols-[1fr_400px]">
      {/* Main column */}
      <div className="min-w-0 space-y-5">
        {isPending ? (
          <Skeleton className="aspect-video w-full rounded-card" />
        ) : (
          <div className="relative">
            <VideoPlayer
              ref={playerRef} key={`${videoId}:${privacy}:${audioOnly}`} videoId={videoId} localKind={localKind}
              resumeSec={resumeSec} onEnded={onEnded}
              privacyProxy={online && privacy} audioOnly={online && audioOnly}
              onNeedsProxyForPip={enablePrivacyForPip}
              autoRequestPip={pipPending} onPipRequestHandled={() => setPipPending(false)}
              onNeedsProxyForBoost={enablePrivacyForBoost}
              autoOpenBoost={boostPending} onBoostOpenHandled={() => setBoostPending(false)}
              skipSegments={online ? segments : undefined}
              onSkip={(cat) => toast.info(`Skipped ${SB_LABELS[cat] ?? cat}`)}
              chapters={chapters}
              onTime={(s) => {
                secRef.current = s; setCurrentSec(Math.floor(s))
                // Scrubbing back into the video (or it simply not being at the very end
                // anymore) cancels a pending "up next" countdown.
                if (countdown && meta?.durationSec && s < meta.durationSec - 1.5) setCountdown(null)
              }}
              onPlaying={(p) => { playingRef.current = p; if (p && countdown) setCountdown(null) }}
              videoMeta={videoMeta}
            />
            {countdown && upNext[0] && (
              <AutoplayCountdown
                nextItem={upNext[0]} secondsLeft={countdown.secondsLeft} total={countdown.total}
                onCancel={() => setCountdown(null)}
                onPlayNow={() => { const nx = upNext[0]; setCountdown(null); navigate(watchHref(nx)) }}
              />
            )}
          </div>
        )}

        <InfoPanel videoId={videoId} title={title} author={author} channelThumb={channelThumb} meta={meta}
          votes={votes ?? null} localKind={localKind}
          privacy={privacy} onTogglePrivacy={togglePrivacy}
          audioOnly={audioOnly} onToggleAudioOnly={toggleAudioOnly}
          isShortVid={isShortVid} onMinimize={minimize} />
      </div>

      {/* Side column */}
      <aside className="min-w-0 space-y-5">
        <SidePanel
          videoId={videoId} tab={tab} setTab={setTab} currentSec={currentSec}
          onSeek={(sec) => playerRef.current?.seek(sec)} initialSummary={meta?.summary ?? null}
        />
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <h3 className="text-sm font-semibold">Up next</h3>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
              Autoplay
              <button onClick={() => setAutoplay(a => !a)} role="switch" aria-checked={autoplay}
                className={cn('relative h-5 w-9 rounded-full transition-colors', autoplay ? 'bg-[var(--yt-accent)]' : 'bg-muted-foreground/30')}>
                <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-transform', autoplay ? 'translate-x-4' : 'translate-x-0.5')} />
              </button>
            </label>
          </div>
          <div className="space-y-1">
            {upNext.map(i => <UpNextRow key={i.videoId} item={i} />)}
            {upNext.length === 0 && <p className="px-1 py-4 text-xs text-muted-foreground">Nothing queued.</p>}
          </div>
        </Card>
      </aside>
    </PageContainer>
  )
}

// ── Info panel ───────────────────────────────────────────────────────────────

function InfoPanel({ videoId, title, author, channelThumb, meta, votes, localKind,
  privacy, onTogglePrivacy, audioOnly, onToggleAudioOnly, isShortVid, onMinimize }: {
  videoId: string
  title: string
  author: string | null
  channelThumb: string | null
  meta: VideoMeta | undefined
  votes: VideoVotes | null
  localKind?: 'audio' | 'video'
  privacy: boolean
  onTogglePrivacy: () => void
  audioOnly: boolean
  onToggleAudioOnly: () => void
  isShortVid: boolean
  onMinimize: () => void
}) {
  const online = !localKind
  const ui = useYoutubeUI()
  const qc = useQueryClient()
  const { shareLink } = useShareLink()
  const [expanded, setExpanded] = useState(false)
  // One-click Save: yt-dlp downloads this to the Offline library at the user's default quality.
  const savedRemote = useSavedState(videoId)
  const [savingLocal, setSavingLocal] = useState(false)
  const saveState: 'saved' | 'saving' | null = localKind ? 'saved' : savingLocal ? 'saving' : savedRemote
  async function saveVideoOffline() {
    if (saveState === 'saved' || saveState === 'saving') return
    setSavingLocal(true)
    try {
      const d = await saveOffline({ videoId, title, kind: 'video' })
      if (d.error) { toast.error(d.error); return }
      toast.success(d.status === 'already-saved' ? 'Already saved offline' : 'Saving offline — find it under Offline')
      qc.invalidateQueries({ queryKey: ['yt-downloads'] })
    } catch { toast.error('Could not save') } finally { setSavingLocal(false) }
  }
  const [podcastOpen, setPodcastOpen] = useState(false)
  const [subbed, setSubbed] = useState(meta?.subscribed ?? false)
  const [subId, setSubId] = useState(meta?.subscriptionId ?? null)
  const [subBusy, setSubBusy] = useState(false)
  const channelId = meta?.channelId ?? null
  const description = meta?.description ?? null
  const views = fmtViews(meta?.views)

  // Sync subscribe state once meta resolves (InfoPanel renders before meta loads).
  useEffect(() => {
    if (meta?.subscribed !== undefined) { setSubbed(meta.subscribed); setSubId(meta.subscriptionId ?? null) }
  }, [meta?.subscribed, meta?.subscriptionId])

  const snapshot = { videoId, title, author, channelId, channelThumb, durationSec: meta?.durationSec ?? null }
  const liked = useCollection('liked').some(v => v.videoId === videoId)
  const watchLater = useCollection('watch-later').some(v => v.videoId === videoId)

  // Live DVR: record an in-progress stream from its start. `recording` is local UI state only —
  // the capture itself runs server-side as a durable job, so reloading this page just loses the
  // "Stop" affordance (clicking Record again harmlessly coalesces onto the same in-progress job).
  const [recording, setRecording] = useState(false)
  const [recordBusy, setRecordBusy] = useState(false)
  async function toggleRecording() {
    setRecordBusy(true)
    try {
      if (recording) {
        await stopLiveRecord(videoId)
        setRecording(false)
        toast.success('Recording finalizing — check Offline library shortly')
      } else {
        const d = await startLiveRecord(videoId, title)
        if (d.error) { toast.error(d.error); return }
        setRecording(true)
        toast.success('Recording from the start of the stream')
      }
    } catch { toast.error('Could not update the recording') } finally { setRecordBusy(false) }
  }

  const { ask: askUnsub, dialog: unsubDialog } = useUnsubscribeConfirm()
  async function toggleSub() {
    if (!channelId) return
    if (subbed) {
      askUnsub({
        name: author || 'this channel',
        sourceRef: `channel:${channelId}`,
        kind: 'channel',
        onUnsubscribe: async () => {
          if (subId) await deleteSubscription(subId)
          setSubbed(false); setSubId(null); toast.success('Unsubscribed')
          qc.invalidateQueries({ queryKey: ['yt-subs'] })
          qc.invalidateQueries({ queryKey: ['yt-feed'] })
        },
      })
      return
    }
    setSubBusy(true)
    try {
      const d = await addSubscription(`https://www.youtube.com/channel/${channelId}`)
      if (d.error) { toast.error(d.error); return }
      setSubbed(true); setSubId(d.subscription?.id ?? null); toast.success('Subscribed')
      qc.invalidateQueries({ queryKey: ['yt-subs'] })
      qc.invalidateQueries({ queryKey: ['yt-feed'] })
    } catch { toast.error('Could not update subscription') } finally { setSubBusy(false) }
  }

  return (
    <div className="space-y-4">
      {unsubDialog}
      {/* design-ok(raw-h1-in-pages): video title is content on a full-bleed watch surface, not page chrome */}
      <h1 className="text-title leading-tight">{title}</h1>

      <div className="flex flex-wrap items-center gap-3">
        {author && (channelId ? (
          <Link to={`/youtube/channel/${encodeURIComponent(channelId)}`} state={{ title: author, thumbnailUrl: channelThumb }}
            className="group flex items-center gap-2.5">
            <ChannelAvatar title={author} src={channelThumb} className="size-10 text-sm ring-1 ring-border/40 transition group-hover:ring-2 group-hover:ring-[var(--yt-accent)]" />
            <p className="text-sm font-semibold transition-colors group-hover:text-[var(--yt-accent-fg)]">{author}</p>
          </Link>
        ) : (
          <div className="flex items-center gap-2.5">
            <ChannelAvatar title={author} src={channelThumb} className="size-10 text-sm ring-1 ring-border/40" />
            <p className="text-sm font-semibold">{author}</p>
          </div>
        ))}
        {channelId && (subbed ? (
          <Button variant="secondary" size="icon" onClick={toggleSub} disabled={subBusy} title="Subscribed. Click to unsubscribe" aria-label="Subscribed"
            className="bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60">
            {subBusy ? <Spinner /> : <Check className="size-4" />}
          </Button>
        ) : (
          <Button onClick={toggleSub} disabled={subBusy}
            className="gap-1.5 bg-[var(--yt-accent)] font-semibold text-white hover:bg-[var(--yt-accent-hover)] disabled:opacity-60">
            {subBusy && <Spinner className="text-white" />}Subscribe
          </Button>
        ))}
        {votes && <VotesBar votes={votes} />}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {/* Player options — grouped so the row reads as one control, not a scatter of circles */}
          <div className="flex items-center gap-0.5 rounded-full border border-border/60 p-1">
            <SegBtn icon={SquareArrowOutDownLeft} label="Minimize to mini-player" onClick={onMinimize}
              title="Minimize: keep playing in the mini-player while you browse. Note: the mini-player streams directly from YouTube (not the private proxy)." />
            {online && (
              <SegBtn icon={ShieldCheck} label="Private stream" active={privacy} tone="success" iconFill={privacy} onClick={onTogglePrivacy}
                title="Private stream: route through this server so Google never sees you. Slower to start and caps at 720p." />
            )}
            {online && (
              <SegBtn icon={Headphones} label="Audio only" active={audioOnly} tone="info" onClick={onToggleAudioOnly}
                title="Audio only: play just the audio to save bandwidth." />
            )}
            {isShortVid && (
              <SegBtn icon={Smartphone} label="Shorts view" to={`/youtube/shorts/${videoId}`} title="Open in Shorts view" />
            )}
          </div>

          {/* Actions — primary ones inline, the rest folded into a ⋯ menu */}
          <div className="flex items-center gap-0.5 rounded-full bg-muted p-1">
            <SegBtn icon={Heart} label="Like" active={liked} tone="accent" iconFill={liked} onClick={() => toggleCollection('liked', snapshot)} />
            <AddToPlaylistPill compact video={{ videoId, title, author: author ?? undefined, channelId: channelId ?? undefined, durationSec: meta?.durationSec ?? undefined }} />
            {online && meta?.isLive && (
              <SegBtn icon={recording ? Square : Circle} label={recording ? 'Stop recording' : 'Record from start'}
                active={recording} tone="accent" iconFill={recording} onClick={recordBusy ? undefined : toggleRecording}
                title={recording ? 'Stop recording — keeps what was captured' : 'Record this livestream from its start'} />
            )}
            {!localKind && (
              <SegBtn icon={saveState === 'saved' ? Check : HardDriveDownload}
                label={saveState === 'saved' ? 'Saved offline' : saveState === 'saving' ? 'Saving offline…' : 'Save offline'}
                active={saveState === 'saved'} iconFill={false}
                onClick={saveState === 'saving' ? undefined : saveVideoOffline}
                title="Save offline: this server downloads the video so you can watch it later without streaming." />
            )}
            <SegBtn icon={Download} label="Download" onClick={() => ui.openDownload(videoId, title, localKind)}
              title="Download: pull the video file down to this device (like any web download)." />
            <SegBtn icon={Share2} label="Share" onClick={() => shareLink(`${window.location.origin}/youtube/watch/${videoId}`, { label: 'Link' })} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button title="More actions" aria-label="More actions"
                  className="grid size-8 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-background/60 data-[state=open]:bg-background/70 data-[state=open]:text-foreground">
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => toggleCollection('watch-later', snapshot)}>
                  <Clock className={cn('size-4', watchLater && 'fill-current text-[var(--yt-accent-fg)]')} />
                  {watchLater ? 'Remove from Watch Later' : 'Watch Later'}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setPodcastOpen(true)}>
                  <Mic className="size-4" /> Create podcast
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank', 'noopener,noreferrer')}>
                  <ExternalLink className="size-4" /> Open on YouTube
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {(views || description) && (
        <Card variant="flat" className="p-4 text-sm leading-relaxed text-foreground/85">
          {views && <div className="mb-2 font-semibold text-foreground">{views}</div>}
          {description && (
            <>
              <div className={cn('whitespace-pre-wrap', !expanded && 'line-clamp-3')}>{description}</div>
              <button onClick={() => setExpanded(e => !e)} className="mt-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
                {expanded ? 'Show less' : '…more'}
              </button>
            </>
          )}
        </Card>
      )}

      <CreatePodcastDialog open={podcastOpen} onClose={() => setPodcastOpen(false)}
        videos={[{ videoId, title, author: author ?? undefined }]}
        sourceLabel={title} suggestedShowName={author ?? undefined} defaultLabel={title} />
    </div>
  )
}

/** A compact icon button that lives inside one of the grouped segment bars in the action row.
 *  Renders as a <Link> when `to` is set, otherwise a <button>. */
function SegBtn({ icon: Icon, label, title, active, tone = 'accent', iconFill, onClick, to }: {
  icon: typeof Heart; label: string; title?: string; active?: boolean
  tone?: 'accent' | 'success' | 'info'; iconFill?: boolean; onClick?: () => void; to?: string
}) {
  const activeText = tone === 'success' ? 'text-success' : tone === 'info' ? 'text-info' : 'text-[var(--yt-accent-fg)]'
  const cls = cn(
    'grid size-8 place-items-center rounded-full transition-colors hover:bg-background/60',
    active ? cn('bg-background/70', activeText) : 'text-foreground/70',
  )
  const icon = <Icon className={cn('size-4', iconFill && 'fill-current')} />
  if (to) return <Link to={to} title={title ?? label} aria-label={label} className={cls}>{icon}</Link>
  return <button onClick={onClick} title={title ?? label} aria-label={label} className={cls}>{icon}</button>
}

// Estimated like/dislike counts from Return YouTube Dislike (YouTube hides dislikes).
function VotesBar({ votes }: { votes: VideoVotes }) {
  return (
    <div className="flex items-center rounded-full bg-muted text-[13px] font-semibold text-foreground/80"
      title="Estimated by Return YouTube Dislike">
      <span className="flex items-center gap-1.5 px-3 py-1.5"><ThumbsUp className="size-3.5" />{fmtCount(votes.likes)}</span>
      <span className="my-1.5 h-4 w-px bg-border" />
      <span className="flex items-center gap-1.5 px-3 py-1.5"><ThumbsDown className="size-3.5" />{fmtCount(votes.dislikes)}</span>
    </div>
  )
}

// ── Side panel: transcript / summary / podcast ───────────────────────────────

function SidePanel({ videoId, tab, setTab, onSeek, initialSummary, currentSec }: {
  videoId: string
  tab: SideTab
  setTab: (t: SideTab) => void
  onSeek: (sec: number) => void
  initialSummary: string | null
  currentSec: number
}) {
  return (
    <Card>
      <div className="flex gap-1 border-b border-border/50 px-2 pt-2">
        {([['transcript', 'Transcript'], ['summary', 'AI Summary'], ['comments', 'Comments']] as [SideTab, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors',
              tab === k ? 'border-[var(--yt-accent)] text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>
      <div className="p-3">
        {tab === 'transcript' && <TranscriptTab videoId={videoId} onSeek={onSeek} currentSec={currentSec} />}
        {tab === 'summary' && <SummaryTab videoId={videoId} initial={initialSummary} />}
        {tab === 'comments' && <CommentsTab videoId={videoId} />}
      </div>
    </Card>
  )
}

function TranscriptTab({ videoId, onSeek, currentSec }: { videoId: string; onSeek: (sec: number) => void; currentSec: number }) {
  const [q, setQ] = useState('')
  const activeRef = useRef<HTMLButtonElement>(null)
  const { data, isPending } = useQuery({
    queryKey: ['yt-transcript', videoId],
    queryFn: async () => {
      const [vtt, prose] = await Promise.all([
        fetch(`/api/youtube/transcript/${videoId}`, { credentials: 'include' }).then(r => (r.ok ? r.text() : '')).catch(() => ''),
        getTranscriptText(videoId).catch(() => null),
      ])
      return { lines: parseVtt(vtt) as TranscriptLine[], prose }
    },
  })

  const lines = data?.lines ?? []
  const ql = q.trim().toLowerCase()

  // The line currently being spoken: the last one whose timestamp we've passed.
  const activeIdx = useMemo(() => {
    if (ql || !lines.length) return -1
    let idx = -1
    for (let i = 0; i < lines.length; i++) { if (lines[i]!.sec <= currentSec + 0.25) idx = i; else break }
    return idx
  }, [lines, currentSec, ql])

  // Follow along: keep the active line in view (only while not searching).
  useEffect(() => { if (activeIdx >= 0) activeRef.current?.scrollIntoView({ block: 'nearest' }) }, [activeIdx])

  if (isPending) return <Centered><Spinner /> Fetching captions…</Centered>
  const prose = data?.prose ?? null
  if (!lines.length && !prose) return <Empty>No transcript available for this video.</Empty>

  const shown = ql ? lines.filter(l => l.text.toLowerCase().includes(ql)) : lines

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-control border border-border/60 bg-background px-3 py-2">
        <Search className="size-3.5 text-muted-foreground" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search transcript" className="w-full bg-transparent text-sm outline-none" />
      </div>
      <div className="max-h-[440px] space-y-1 overflow-y-auto pr-1">
        {lines.length > 0 ? (
          shown.map((l, idx) => {
            const active = !ql && lines[activeIdx] === l
            return (
              <button key={`${l.sec}-${idx}`} ref={active ? activeRef : undefined} onClick={() => onSeek(l.sec)}
                className={cn('flex w-full gap-2.5 rounded-control border-l-2 px-2 py-1.5 text-left text-sm transition-colors',
                  active ? 'border-[var(--yt-accent)] bg-[var(--yt-accent)]/15' : 'border-transparent hover:bg-accent/60')}>
                <span className={cn('shrink-0 rounded px-1 py-0.5 font-mono text-xs font-semibold tabular-nums',
                  active ? 'bg-[var(--yt-accent)] text-white' : 'text-[var(--yt-accent-fg)]')}>{l.label}</span>
                <span className={cn(active ? 'font-semibold text-foreground' : 'text-foreground/85')}>{l.text}</span>
              </button>
            )
          })
        ) : (
          <div className="space-y-3 px-1 text-sm leading-relaxed text-foreground/85">
            {(prose ?? '').split('\n\n').map((p, i) => <p key={i} className="whitespace-pre-wrap">{p}</p>)}
          </div>
        )}
        {lines.length > 0 && shown.length === 0 && <Empty>No lines match “{q}”.</Empty>}
      </div>
    </div>
  )
}

function SummaryTab({ videoId, initial }: { videoId: string; initial: string | null }) {
  const { data, isPending } = useQuery({
    queryKey: ['yt-summary', videoId],
    queryFn: () => summarize(videoId),
    initialData: initial && initial.length > 0 ? initial : undefined,
  })
  if (isPending) return <Centered><Spinner /> Summarizing…</Centered>
  if (!data) return <Empty>No summary available. This video has no captions to summarize.</Empty>
  return <div className="max-h-[480px] space-y-3 overflow-y-auto whitespace-pre-wrap px-1 text-sm leading-relaxed text-foreground/85">{data}</div>
}

function CommentsTab({ videoId }: { videoId: string }) {
  const { data: comments = [], isPending } = useQuery({ queryKey: ['yt-comments', videoId], queryFn: () => getComments(videoId, 30) })
  if (isPending) return <Centered><Spinner /> Loading comments…</Centered>
  if (!comments.length) return <Empty>No comments. They may be turned off for this video.</Empty>
  return (
    <div className="max-h-[520px] space-y-4 overflow-y-auto pr-1">
      {comments.map((c, i) => (
        <div key={i} className="flex gap-2.5">
          {c.authorThumb
            ? <img src={ytImageProxy(c.authorThumb)} alt="" referrerPolicy="no-referrer" className="mt-0.5 size-7 shrink-0 rounded-full object-cover" />
            : <div className="mt-0.5 size-7 shrink-0 rounded-full bg-muted" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {c.pinned && <Pin className="size-3 text-[var(--yt-accent-fg)]" />}
              <span className="font-semibold text-foreground/90">{c.author}</span>
              {c.publishedText && <span>· {c.publishedText}</span>}
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{c.text}</p>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
              {c.likeCount && <span className="flex items-center gap-1"><ThumbsUp className="size-3" />{c.likeCount}</span>}
              {c.replyCount ? <span>{c.replyCount} {c.replyCount === 1 ? 'reply' : 'replies'}</span> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">{children}</div>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-sm text-muted-foreground/70">{children}</p>
}
