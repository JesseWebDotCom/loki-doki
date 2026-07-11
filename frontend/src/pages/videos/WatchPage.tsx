import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import {
  HardDriveDownload, Download, Heart, Clock, Search, Smartphone, Mic, Check,
  ThumbsUp, Pin, SquareArrowOutDownLeft, MoreHorizontal, Circle, Square, Plus,
} from 'lucide-react'
import { ExternalLink, Share2, PictureInPicture2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useArtPalette } from '@/lib/artPalette'
import { videoAccentVars } from '@/components/videos/AccentScope'
import { UltraBlur } from '@/components/shared/UltraBlur'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { PageContainer } from '@/components/shared/PageContainer'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import { useYoutubeUI, useYoutubeModeOptional } from '@/components/videos/VideosLayout'
import { VideoPlayer, type VideoPlayerHandle } from '@/components/youtube/VideoPlayer'
import { UpNextRow, watchHref } from '@/components/youtube/VideoCard'
import { AutoplayCountdown, type AutoplayNextItem } from '@/components/youtube/AutoplayCountdown'
import { CreatePodcastDialog } from '@/components/youtube/CreatePodcastDialog'
import { useUnsubscribeConfirm } from '@/components/youtube/UnsubscribeDialog'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { AddToPlaylistPill } from '@/components/youtube/AddToPlaylistButton'
import { useYtFeed, useSavedState } from '@/lib/youtube/useData'
import {
  getVideoMeta, summarize, getTranscriptText, getRelated, getSponsorSegments,
  getComments, getChapters, getVotes, addSubscription, deleteSubscription,
  startLiveRecord, stopLiveRecord, saveOffline, ytImageProxy,
  type VideoMeta, type VideoVotes,
} from '@/lib/youtube/api'
import { itToItem, isShort, type VideoItem } from '@/lib/youtube/types'
import { fmtAge, fmtViews, thumbUrl } from '@/lib/youtube/format'
import { parseChapters } from '@/lib/youtube/chapters'
import { parseVtt, type TranscriptLine } from '@/lib/youtube/transcript'
import { toggleCollection, useCollection } from '@/lib/youtube/collections'
import { useDeArrow } from '@/lib/youtube/dearrow'
import { useYoutubePlayback, type YtMiniTrack } from '@/context/YoutubePlaybackContext'
import { acquireAudio, registerTransport } from '@/lib/mediaCoordinator'
import { useShareLink } from '@/hooks/use-share-link'
import {
  getSourceItem, getSourceComments, getSourceCreator, getSourceRelated, getSourceSummary, getSourceTranscript, listSaves, saveVideo, putWatchState, savedFileUrl,
  listFollows, addFollow, removeFollow, getVideoSources,
  type HubPlayback, type HubVideoItem, type VideoSource,
} from '@/lib/videos/api'
import { HUB_PATHS } from '@/components/videos/HubVideoCard'
import { VideoPlaceholderArt } from '@/components/videos/VideoPlaceholderArt'
import { SOURCE_META } from '@/lib/videos/sources'
import { usePlaylistQueue, playlistWatchHref } from '@/lib/videos/playlistWatch'
import { PlaylistQueuePanel } from '@/components/videos/PlaylistQueuePanel'
import { VimeoWatchPlayer } from '@/components/videos/VimeoWatchPlayer'
import { TikTokWatchPlayer } from '@/components/videos/TikTokWatchPlayer'
import { PlayerControlBar } from '@/components/videos/PlayerControlBar'
import { PlayerClickToggle } from '@/components/videos/PlayerClickToggle'
import { useFullscreenToggle } from '@/hooks/use-fullscreen-toggle'

/** A feed/related item → a mini-player queue entry. */
const toMiniTrack = (v: VideoItem): YtMiniTrack => ({
  videoId: v.videoId, title: v.title, author: v.author ?? null,
  channelThumb: v.channelThumb ?? null, localKind: v.localKind, durationSec: v.durationSec ?? null,
})

type SideTab = 'upnext' | 'transcript' | 'comments'

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

/** Single watch page for every source: YouTube's rich feature set (SponsorBlock, DeArrow,
 *  chapters/transcript, mini-player docking, PiP, live DVR, playlists) is capability-gated
 *  behind `source === 'youtube'`; every source renders through the same shell (title, creator
 *  row, segmented action buttons, description card, tabbed side panel) so the page looks and
 *  behaves the same everywhere — YouTube just lights up more of it. */
export function WatchPage() {
  const { source: sourceParam, id } = useParams<{ source: string; id: string }>()
  const source = (sourceParam ?? 'youtube') as VideoSource
  const videoId = id ?? ''
  if (source === 'youtube') return <YoutubeWatch videoId={videoId} />
  return <GenericWatch source={source} videoId={videoId} />
}

// ── Shared shell pieces ──────────────────────────────────────────────────────

/** The watch page's cinema shell (both branches render through it): an UltraBlur wallpaper
 *  band built from the video's own thumbnail dissolves into the hub's black, and the page
 *  subtree's accent vars retint to a palette extracted from that art, so every already-tinted
 *  control (SegBtns, Subscribe, tab underlines, progress bars) follows the video with zero
 *  per-control edits. One of the three sanctioned dynamic-palette surfaces. No art (or a
 *  still-loading palette) simply keeps the mode accent. */
function WatchCinema({ art, children }: { art: string | null; children: React.ReactNode }) {
  const palette = useArtPalette(art)
  return (
    <div className="relative" style={art ? videoAccentVars(palette) : undefined}>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[560px] overflow-hidden">
        <UltraBlur artUrl={art} palette={palette} scrim="light" />
        {/* Dissolve the wallpaper into the layout's true black so it reads as atmosphere. */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/30 to-black" />
      </div>
      <div className="relative">{children}</div>
    </div>
  )
}

/** Views + expandable description, the same Card style everywhere. The toggle only shows when
 *  the 3-line clamp is actually cutting text off — a short description that fits within 3
 *  lines has nothing more to reveal. Measured via scrollHeight vs clientHeight (line-clamp
 *  keeps the full text laid out, just visually hidden, so this reads accurately) rather than
 *  a character-count guess, since description length alone doesn't determine wrapped line count. */
function DescriptionCard({ views, description }: { views: string | null; description: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = textRef.current
    setOverflowing(!!el && el.scrollHeight > el.clientHeight + 1)
  }, [description])

  if (!views && !description) return null
  // Borderless, straight on the cinema backdrop (the music "About" language) - no card box.
  return (
    <div className="px-1 text-sm leading-relaxed text-foreground/85">
      {views && <div className="mb-2 font-semibold text-foreground">{views}</div>}
      {description && (
        <>
          <div ref={textRef} className={cn('whitespace-pre-wrap', !expanded && 'line-clamp-3')}>{description}</div>
          {overflowing && (
            <button onClick={() => setExpanded((e) => !e)} className="mt-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
              {expanded ? 'Show less' : '…more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** Tabbed Card shell for the side column: same tab-header style (border-b, active underline)
 *  for every source, whatever tabs it actually has. */
function SidePanelShell<T extends string>({ tabs, active, onChange, action, children }: {
  tabs: Array<{ key: T; label: string }>
  active: T
  onChange: (t: T) => void
  /** Optional right-aligned control on the tab row (e.g. the queue's Autoplay toggle). */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  if (tabs.length === 0) return null
  // The music player's pill switcher (NowPlayingOverlay language): floating rounded-full
  // group, active tab solid white - no card box, no underline tabs.
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        {/* design-ok(glass-on-plain-bg): pill tab switcher over the watch page's UltraBlur cinema backdrop */}
        <div className="no-scrollbar flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-white/10 p-1">
          {tabs.map(({ key, label }) => (
            <button key={key} onClick={() => onChange(key)}
              className={cn('shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors',
                active === key ? 'bg-white text-black' : 'text-white/70 hover:text-white')}>
              {label}
            </button>
          ))}
        </div>
        {action}
      </div>
      <div className="px-1 pt-3 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:overflow-hidden">{children}</div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">{children}</div>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-sm text-muted-foreground/70">{children}</p>
}

// ── YouTube branch (unchanged behavior, restyled through the shared shell) ──────

function YoutubeWatch({ videoId }: { videoId: string }) {
  const [params] = useSearchParams()
  const localKind = (params.get('k') as 'audio' | 'video' | null) ?? undefined
  const navigate = useNavigate()
  const pb = useYoutubePlayback()
  const playerRef = useRef<VideoPlayerHandle>(null)
  const [tab, setTab] = useState<SideTab>('upnext')
  const [autoplay, setAutoplay] = useState(true)
  // Present when this video was opened via a playlist's "Play all" or a row click (?plist=&
  // ppos=) — autoplay then advances through the playlist's own order instead of algorithmic
  // "related" videos, and the sidebar shows the playlist queue instead of Up Next.
  const pq = usePlaylistQueue()
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
    next: () => { const nx = miniQueueRef.current[1]?.videoId; if (nx) navigate(`/videos/youtube/watch/${nx}`) },
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
    if (!autoplay) return
    if (pq.active) { if (pq.next) setCountdown({ secondsLeft: AUTOPLAY_COUNTDOWN_SEC, total: AUTOPLAY_COUNTDOWN_SEC }); return }
    if (upNext[0]) setCountdown({ secondsLeft: AUTOPLAY_COUNTDOWN_SEC, total: AUTOPLAY_COUNTDOWN_SEC })
  }

  // Advances to whatever's "next" — the playlist's own next entry when one is active,
  // otherwise the algorithmic up-next pick.
  function goToNext() {
    setCountdown(null)
    if (pq.active) {
      // usePlaylistQueue already skips Mine (no watch page) when picking `next`; the check
      // here is just to satisfy the type narrowing, not a real runtime case.
      if (pq.next && pq.next.videoSource !== 'mine' && pq.playlistId) {
        navigate(playlistWatchHref(pq.next.videoSource, pq.next.videoId, pq.playlistId, pq.nextIndex))
      }
      return
    }
    const nx = upNext[0]
    if (nx) navigate(watchHref(nx))
  }

  // Ticks the "playing next" countdown down once a second and navigates when it hits 0.
  useEffect(() => {
    if (!countdown) return
    if (countdown.secondsLeft <= 0) { goToNext(); return }
    const t = setTimeout(() => setCountdown(c => (c ? { ...c, secondsLeft: c.secondsLeft - 1 } : null)), 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown])

  const countdownNext: AutoplayNextItem | null = pq.active
    ? (pq.next ? { title: pq.next.title, author: pq.next.author, videoId: pq.next.videoSource === 'youtube' ? pq.next.videoId : undefined, thumbnailUrl: pq.next.videoSource === 'youtube' ? undefined : pq.next.thumbnailUrl } : null)
    : (upNext[0] ?? null)

  // Pop the video into the docked mini-player and leave the watch page. Forces the dock
  // (even if paused) so the button always does something; navigating away would otherwise
  // only hand off while playing.
  function minimize() {
    pb.dock(miniQueueRef.current, 0, secRef.current || currentSec)
    navigate('/videos/youtube')
  }

  return (
   <WatchCinema art={ytImageProxy(thumbUrl(videoId, 'hq'))}>
    <PageContainer width="full" className="py-6">
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 xl:grid-cols-[1fr_400px]">
      {/* Main column: player with the vertical action rail beside it, then a calm title
          block (one title, creator subtitle, readable description - nothing else). */}
      <div className="min-w-0 space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
      {/* design-ok(adhoc-container): viewport-height-derived cap so an ultrawide column
          can't make the video taller than the screen; the rail hugs its right edge. */}
      <div className="min-w-0 flex-1 lg:max-w-[calc(78vh*(16/9))]">
      {isPending ? (
        <Skeleton className="aspect-video w-full rounded-card" />
      ) : (
        <div className="relative overflow-hidden rounded-card shadow-2xl">
            <VideoPlayer
              ref={playerRef} key={`${videoId}:${privacy}:${audioOnly}`} videoId={videoId} localKind={localKind}
              resumeSec={resumeSec} onEnded={onEnded}
              privacyProxy={online && privacy} audioOnly={online && audioOnly}
              onTogglePrivacy={online ? togglePrivacy : undefined}
              onToggleAudioOnly={online ? toggleAudioOnly : undefined}
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
            {countdown && countdownNext && (
              <AutoplayCountdown
                nextItem={countdownNext} secondsLeft={countdown.secondsLeft} total={countdown.total}
                onCancel={() => setCountdown(null)}
                onPlayNow={goToNext}
              />
            )}
          </div>
        )}
      </div>
        <YoutubeActionRail videoId={videoId} title={title} author={author}
          channelId={meta?.channelId ?? null} channelThumb={channelThumb} meta={meta}
          localKind={localKind} isShortVid={isShortVid} onMinimize={minimize} />
      </div>

        <YoutubeInfoPanel videoId={videoId} title={title} author={author} channelThumb={channelThumb} meta={meta}
          votes={votes ?? null} />
      </div>

      {/* Side column: ONE tabbed rail - the queue is the first (default) tab, not a second
          module stacked under the panel. */}
      <aside className="min-w-0 xl:sticky xl:top-6 xl:flex xl:h-[calc(100dvh-7rem)] xl:min-h-0 xl:flex-col xl:self-start">
        <SidePanelShell
          tabs={[
            { key: 'upnext' as SideTab, label: pq.active && pq.playlistId ? 'Queue' : 'Up next' },
            { key: 'transcript' as SideTab, label: 'Transcript' },
            { key: 'comments' as SideTab, label: 'Comments' },
          ]}
          active={tab} onChange={setTab}
          action={tab === 'upnext' ? (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 pr-1 text-xs font-medium text-muted-foreground">
              Autoplay
              <button onClick={() => setAutoplay(a => !a)} role="switch" aria-checked={autoplay}
                className={cn('relative h-5 w-9 rounded-full transition-colors', autoplay ? 'bg-[var(--yt-accent)]' : 'bg-muted-foreground/30')}>
                <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-transform', autoplay ? 'translate-x-4' : 'translate-x-0.5')} />
              </button>
            </label>
          ) : undefined}>
          {tab === 'upnext' && (
            pq.active && pq.playlistId ? (
              <PlaylistQueuePanel playlistId={pq.playlistId} playlistName={pq.playlistName} videos={pq.videos} pos={pq.pos} />
            ) : (
              <div className="space-y-1 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
                {upNext.map(i => <UpNextRow key={i.videoId} item={i} />)}
                {upNext.length === 0 && <p className="px-1 py-4 text-xs text-muted-foreground">Nothing queued.</p>}
              </div>
            )
          )}
          {tab === 'transcript' && <TranscriptTab videoId={videoId} onSeek={(sec) => playerRef.current?.seek(sec)} currentSec={currentSec} />}
          {tab === 'comments' && <YoutubeCommentsTab videoId={videoId} />}
        </SidePanelShell>
      </aside>
      </div>
    </PageContainer>
   </WatchCinema>
  )
}

// ── YouTube info panel ───────────────────────────────────────────────────────

function YoutubeInfoPanel({ videoId, title, author, channelThumb, meta, votes }: {
  videoId: string
  title: string
  author: string | null
  channelThumb: string | null
  meta: VideoMeta | undefined
  votes: VideoVotes | null
}) {
  const qc = useQueryClient()
  const [showOriginalDescription, setShowOriginalDescription] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [subbed, setSubbed] = useState(meta?.subscribed ?? false)
  const [subId, setSubId] = useState(meta?.subscriptionId ?? null)
  const [subBusy, setSubBusy] = useState(false)
  const channelId = meta?.channelId ?? null
  const subscribers = meta?.subscribers ?? null
  // Smart Description (promotional content stripped) once the background enrichment has
  // generated one; the raw description is still what's used for chapter parsing above
  // (descChapters), since chapters are creator-authored timestamps, not promotional content.
  // "View original" only makes sense (and only shows) when Smart Description actually
  // changed something — a video whose description had nothing promotional to strip has an
  // identical descriptionClean, so there'd be nothing to toggle to.
  const hasOriginalDescription = !!meta?.descriptionClean && !!meta?.description && meta.descriptionClean !== meta.description
  const description = (showOriginalDescription ? meta?.description : meta?.descriptionClean) ?? meta?.description ?? null
  // "1.2M views · 7y ago" under the title, matching what every card already shows.
  const views = [fmtViews(meta?.views), fmtAge(meta?.publishedAt)].filter(Boolean).join(' · ')

  // Sync subscribe state once meta resolves (InfoPanel renders before meta loads).
  useEffect(() => {
    if (meta?.subscribed !== undefined) { setSubbed(meta.subscribed); setSubId(meta.subscriptionId ?? null) }
  }, [meta?.subscribed, meta?.subscriptionId])

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

  const subtitle = (
    // The creator is a quiet subtitle line under the title (course-page language), not a
    // chip competing with the actions. Subscribe rides along as one compact pill.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1.5">
      {author && (
        <span className="flex items-center gap-2">
          <CreatorAvatar title={author} src={channelThumb} className="size-6 text-[10px] ring-1 ring-white/15" />
          {channelId ? (
            <Link to={`/videos/youtube/channel/${encodeURIComponent(channelId)}`} state={{ title: author, thumbnailUrl: channelThumb }}
              className="text-sm font-medium text-white/80 transition-colors hover:text-[var(--yt-accent-fg)]">{author}</Link>
          ) : (
            <span className="text-sm font-medium text-white/80">{author}</span>
          )}
          {subscribers && <span className="text-xs text-muted-foreground">{subscribers}</span>}
        </span>
      )}
      {channelId && (subbed ? (
        // design-ok(glass-on-plain-bg): compact pill over the UltraBlur cinema backdrop
        <Button size="sm" onClick={toggleSub} disabled={subBusy} title="Subscribed. Click to unsubscribe"
          className="h-7 rounded-full bg-white/10 px-3 text-xs font-semibold text-foreground/75 shadow-none hover:bg-destructive/20 hover:text-destructive disabled:opacity-60">
          {subBusy ? <Spinner className="size-3" /> : <Check className="size-3.5" />} Subscribed
        </Button>
      ) : (
        <Button size="sm" onClick={toggleSub} disabled={subBusy} title="Subscribe"
          className="h-7 rounded-full bg-[var(--yt-accent)] px-3 text-xs font-semibold text-[var(--yt-accent-contrast,white)] shadow-none hover:bg-[var(--yt-accent-hover)] disabled:opacity-60">
          {subBusy ? <Spinner className="size-3 text-current" /> : <Plus className="size-3.5" />} Subscribe
        </Button>
      ))}
    </div>
  )

  return (
    <div className="space-y-4">
      {unsubDialog}
      {/* Calm full-width header: eyebrow + title + creator subtitle. Actions live in the
          vertical rail beside the player, so long titles never wrap around buttons. */}
      <div className="min-w-0 space-y-1.5">
        {(views || votes) && (
          <p className="text-overline text-white/50" title={votes ? `${fmtCount(votes.likes)} likes · ${fmtCount(votes.dislikes)} dislikes (Return YouTube Dislike)` : undefined}>
            {[views, votes ? `${fmtCount(votes.likes)} likes` : null].filter(Boolean).join(' · ')}
          </p>
        )}
        {/* design-ok(raw-h1-in-pages): video title is content on a full-bleed watch surface, not page chrome */}
        <h1 className="text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">{title}</h1>
        {subtitle}
      </div>

      <DescriptionCard views={null}
        description={description ? (hasOriginalDescription ? description : description) : null} />
      {/* Description footnotes: the AI summary lives HERE, inline with the description
          it condenses (fetched only when opened), not as a rail tab. */}
      <div className="-mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        <button onClick={() => setSummaryOpen(v => !v)}
          className={cn('flex items-center gap-1 text-xs font-semibold transition-colors',
            summaryOpen ? 'text-[var(--yt-accent-fg)]' : 'text-muted-foreground hover:text-foreground')}>
          <Sparkles className="size-3" /> {summaryOpen ? 'Hide AI summary' : 'AI summary'}
        </button>
        {hasOriginalDescription && description && (
          <button onClick={() => setShowOriginalDescription(v => !v)} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
            {showOriginalDescription ? 'Show cleaned description' : 'View original'}
          </button>
        )}
      </div>
      {summaryOpen && (
        <div className="rounded-card bg-white/[0.04] p-4 ring-1 ring-white/10">
          <SummaryTab videoId={videoId} initial={meta?.summary ?? null} />
        </div>
      )}
    </div>
  )
}

/** Vertical icon rail beside the player (the TikTok/Reels pattern): like, save, share,
 *  playlist and the ⋯ menu live here as unlabeled circles, so the title block keeps the
 *  full column width. Wraps to a horizontal row under the player on smaller screens. */
function YoutubeActionRail({ videoId, title, author, channelId, channelThumb, meta, localKind, isShortVid, onMinimize }: {
  videoId: string
  title: string
  author: string | null
  channelId: string | null
  channelThumb: string | null
  meta: VideoMeta | undefined
  localKind?: 'audio' | 'video'
  isShortVid: boolean
  onMinimize: () => void
}) {
  const online = !localKind
  const ui = useYoutubeUI()
  const qc = useQueryClient()
  const { shareLink } = useShareLink()
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
  const snapshot = { videoId, title, author, channelId, channelThumb, durationSec: meta?.durationSec ?? null, videoSource: 'youtube' as const }
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

  // design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop
  const railBtn = 'size-10 rounded-full bg-white/10 text-foreground/85 shadow-none hover:bg-white/15'
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 lg:w-10 lg:flex-col lg:flex-nowrap lg:justify-start">
      {/* design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop */}
      <Button size="icon" onClick={() => toggleCollection('liked', snapshot)}
        title={liked ? 'Remove from Liked' : 'Like'} aria-label={liked ? 'Remove from Liked' : 'Like'}
        className={cn(railBtn, liked && 'text-[var(--yt-accent-fg)]')}>
        <Heart className={cn('size-4', liked && 'fill-current')} />
      </Button>
      {!localKind && (
        <Button size="icon" onClick={saveState === 'saving' ? undefined : saveVideoOffline} disabled={saveState === 'saved'}
          title={saveState === 'saved' ? 'Saved offline' : 'Save offline: this server downloads the video so you can watch it later without streaming.'}
          aria-label="Save offline"
          className={cn(railBtn, saveState === 'saved' && 'text-[var(--yt-accent-fg)] disabled:opacity-100')}>
          {saveState === 'saved' ? <Check className="size-4" /> : saveState === 'saving' ? <Spinner className="size-4" /> : <HardDriveDownload className="size-4" />}
        </Button>
      )}
      <Button size="icon" onClick={() => void shareLink(`https://www.youtube.com/watch?v=${videoId}`, { label: 'Link' })}
        title="Share the YouTube link" aria-label="Share" className={railBtn}>
        <Share2 className="size-4" />
      </Button>
      {/* design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop */}
      <span className="grid size-10 place-items-center rounded-full bg-white/10 transition-colors hover:bg-white/15" title="Add to playlist">
        <AddToPlaylistPill compact video={{ videoId, title, author: author ?? undefined, channelId: channelId ?? undefined, durationSec: meta?.durationSec ?? undefined }} />
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" title="More actions" aria-label="More actions"
            className={cn(railBtn, 'data-[state=open]:bg-white/20 data-[state=open]:text-foreground')}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => toggleCollection('watch-later', snapshot)}>
            <Clock className={cn('size-4', watchLater && 'fill-current text-[var(--yt-accent-fg)]')} />
            {watchLater ? 'Remove from Watch Later' : 'Watch Later'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => ui.openDownload(videoId, title, localKind)}>
            <Download className="size-4" /> Download
          </DropdownMenuItem>
          {online && meta?.isLive && (
            <DropdownMenuItem onClick={recordBusy ? undefined : toggleRecording}>
              {recording ? <Square className="size-4 fill-current text-[var(--yt-accent-fg)]" /> : <Circle className="size-4" />}
              {recording ? 'Stop recording' : 'Record from start'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onMinimize}
            title="Keep playing in the mini-player while you browse. Note: the mini-player streams directly from YouTube (not the private proxy).">
            <SquareArrowOutDownLeft className="size-4" /> Minimize to mini-player
          </DropdownMenuItem>
          {isShortVid && (
            <DropdownMenuItem asChild>
              <Link to={`/videos/youtube/shorts/${videoId}`}><Smartphone className="size-4" /> Open in Shorts view</Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setPodcastOpen(true)}>
            <Mic className="size-4" /> Create podcast
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank', 'noopener,noreferrer')}>
            <ExternalLink className="size-4" /> Open on YouTube
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreatePodcastDialog open={podcastOpen} onClose={() => setPodcastOpen(false)}
        videos={[{ videoId, title, author: author ?? undefined }]}
        sourceLabel={title} suggestedShowName={author ?? undefined} defaultLabel={title} />
    </div>
  )
}

/** Timed transcript panel. YouTube reads its own caption endpoints; any other source
 *  (pass `source`) reads the hub transcript route (provider captions API or yt-dlp). */
function TranscriptTab({ videoId, onSeek, currentSec, source = 'youtube' }: { videoId: string; onSeek: (sec: number) => void; currentSec: number; source?: VideoSource }) {
  const [q, setQ] = useState('')
  const activeRef = useRef<HTMLButtonElement>(null)
  const { data, isPending } = useQuery({
    queryKey: source === 'youtube' ? ['yt-transcript', videoId] : ['videos-transcript', source, videoId],
    queryFn: async () => {
      if (source !== 'youtube') {
        const vtt = await getSourceTranscript(source, videoId).catch(() => '')
        return { lines: parseVtt(vtt) as TranscriptLine[], prose: null as string | null }
      }
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

  // Follow along: keep the active line in view (only while not searching). Scoped to the
  // transcript's OWN pane - scrollIntoView would also scroll every ancestor, yanking the
  // whole page down a notch on every caption change.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = activeRef.current, list = listRef.current
    if (activeIdx < 0 || !el || !list) return
    const y = el.offsetTop
    if (y < list.scrollTop + 8 || y + el.offsetHeight > list.scrollTop + list.clientHeight - 8) {
      list.scrollTo({ top: Math.max(0, y - list.clientHeight / 2 + el.offsetHeight / 2) })
    }
  }, [activeIdx])

  if (isPending) return <Centered><Spinner /> Fetching captions…</Centered>
  const prose = data?.prose ?? null
  if (!lines.length && !prose) return <Empty>No transcript available for this video.</Empty>

  const shown = ql ? lines.filter(l => l.text.toLowerCase().includes(ql)) : lines

  return (
    <div className="space-y-3 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:gap-3 xl:space-y-0">
      {/* design-ok(glass-on-plain-bg): glass field over the UltraBlur cinema backdrop */}
      <div className="flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-2">
        <Search className="size-3.5 text-muted-foreground" />
        {/* 16px on phones so iOS doesn't focus-zoom (Mobile Design Contract). */}
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search transcript" className="w-full bg-transparent text-base outline-none md:text-sm" />
      </div>
      {/* `relative` so the active line's offsetTop is measured against THIS pane. */}
      <div ref={listRef} className="relative max-h-[440px] space-y-1 overflow-y-auto pr-1 xl:max-h-none xl:min-h-0 xl:flex-1">
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

/** Transcript-based AI summary. YouTube posts to its own summarize endpoint; any other
 *  source (pass `source`) reads the hub summary route (same prompt/model server-side). */
function SummaryTab({ videoId, initial, source = 'youtube' }: { videoId: string; initial: string | null; source?: VideoSource }) {
  const { data, isPending } = useQuery({
    queryKey: source === 'youtube' ? ['yt-summary', videoId] : ['videos-summary', source, videoId],
    queryFn: () => source === 'youtube' ? summarize(videoId) : getSourceSummary(source, videoId).then((r) => r.summary),
    initialData: initial && initial.length > 0 ? initial : undefined,
  })
  if (isPending) return <Centered><Spinner /> Summarizing…</Centered>
  if (!data) return <Empty>No summary available. This video has no captions to summarize.</Empty>
  return <div className="max-h-[480px] space-y-3 overflow-y-auto whitespace-pre-wrap px-1 text-sm leading-relaxed text-foreground/85 xl:max-h-none xl:min-h-0 xl:flex-1">{data}</div>
}

function YoutubeCommentsTab({ videoId }: { videoId: string }) {
  const { data: comments = [], isPending } = useQuery({ queryKey: ['yt-comments', videoId], queryFn: () => getComments(videoId, 30) })
  if (isPending) return <Centered><Spinner /> Loading comments…</Centered>
  if (!comments.length) return <Empty>No comments. They may be turned off for this video.</Empty>
  return (
    <div className="max-h-[520px] space-y-4 overflow-y-auto pr-1 xl:max-h-none xl:min-h-0 xl:flex-1">
      {comments.map((c, i) => (
        <div key={i} className="flex gap-2.5">
          <CreatorAvatar title={c.author || '?'} src={c.authorThumb} className="mt-0.5 size-7 shrink-0 text-[10px]" />
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

// ── Generic branch (Reddit/TikTok/Vimeo): same shell, hub API underneath ────────

/** Attach the playback source to a <video>: native src for files/progressive, hls.js
 *  for manifests (Safari also gets hls.js; its native HLS can't send our auth cookies
 *  cross-origin, but same-origin proxy URLs are fine either way; prefer the consistent path). */
function usePlaybackAttach(videoRef: React.RefObject<HTMLVideoElement | null>, playback: HubPlayback | null, localUrl: string | null) {
  useEffect(() => {
    const video = videoRef.current
    if (!video || !playback) return

    if (localUrl) {
      video.src = localUrl
      return
    }
    if (playback.mode === 'hls') {
      let hls: import('hls.js').default | null = null
      let cancelled = false
      // Safari can play HLS natively from a same-origin URL; everything else uses hls.js.
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playback.manifestUrl
      } else {
        void import('hls.js').then(({ default: Hls }) => {
          if (cancelled || !Hls.isSupported()) return
          hls = new Hls({ maxBufferLength: 30 })
          hls.loadSource(playback.manifestUrl)
          hls.attachMedia(video)
        })
      }
      return () => { cancelled = true; hls?.destroy() }
    }
    if (playback.mode === 'stream') {
      video.src = playback.streamUrl
      return
    }
  }, [videoRef, playback, localUrl])
}

function GenericWatch({ source, videoId: id }: { source: VideoSource; videoId: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const pb = useYoutubePlayback()
  const videoRef = useRef<HTMLVideoElement>(null)
  const nativeWrapRef = useRef<HTMLDivElement>(null)
  const toggleNativeFullscreen = useFullscreenToggle(nativeWrapRef)
  const [explicitTab, setExplicitTab] = useState<SideTab | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  // Present when this video was opened via a playlist's "Play all" or a row click. Autoplay
  // here only ever means "advance through that playlist" — there's no algorithmic "related"
  // autoplay fallback for hub sources (matches today's no-queue behavior outside a playlist).
  const pq = usePlaylistQueue()
  const [autoplay, setAutoplay] = useState(true)
  const [countdown, setCountdown] = useState<{ secondsLeft: number; total: number } | null>(null)
  // TikTok/Vimeo play through a cross-origin embed <iframe>, which the browser won't let us
  // Picture-in-Picture. When the user asks for PiP we swap the embed for a real <video> fed by
  // the on-demand /api/vstream endpoint (yt-dlp), then request PiP — same handoff YouTube does.
  const [pipStream, setPipStream] = useState(false)
  const [podcastOpen, setPodcastOpen] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['videos-item', source, id],
    queryFn: () => getSourceItem(source, id),
    enabled: !!source && !!id,
  })
  const item: HubVideoItem | undefined = data?.item

  // Liked / Watch Later use the same cross-source collections store as YouTube - rows carry
  // videoSource so the Liked/Watch Later pages can badge and route them per source.
  const liked = useCollection('liked').some(v => v.videoId === id)
  const watchLater = useCollection('watch-later').some(v => v.videoId === id)
  const collectionSnapshot = () => ({
    videoId: id, title: item?.title ?? id, author: item?.creator?.name ?? null,
    channelId: item?.creator?.id ?? null, channelThumb: item?.creator?.avatarUrl ?? null,
    thumbnailUrl: item?.thumbnailUrl ?? null, durationSec: item?.durationSec ?? null,
    videoSource: source as 'reddit' | 'tiktok' | 'vimeo' | 'link',
  })

  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources })
  const capabilities = sourcesData?.sources.find((s) => s.source === source)?.capabilities
  // Default to Transcript like the YouTube panel, unless this source has no transcript
  // capability (its first tab is then Comments, when present).
  const tab: SideTab = explicitTab ?? 'upnext'

  const { data: savesData } = useQuery({ queryKey: ['videos-saves', source], queryFn: () => listSaves(source) })
  const save = savesData?.saves.find((s) => s.videoId === id && s.kind === 'video')
  const localUrl = save?.status === 'ready' ? savedFileUrl(source, id, 'video') : null
  const mode = useYoutubeModeOptional()
  const onlineOnly = mode === 'offline' && !localUrl

  // TikTok/Vimeo play through their official embed <iframe> (instant, no yt-dlp). A saved
  // offline copy always wins — that plays from the local blob via <video>. When pipStream is
  // on (user hit PiP on an embed source) we drop the iframe and stream a real <video> instead.
  const embedUrl = !localUrl && data?.playback?.mode === 'embed' ? data.playback.embedUrl : null
  const showEmbed = !!embedUrl && !pipStream
  const vstreamUrl = `/api/vstream/${source}/${encodeURIComponent(id)}`
  // A real <video> exists whenever we're not showing the embed (native stream/hls/file modes,
  // or the PiP stream swap) — that's what PiP can target.
  const hasNativeVideo = !showEmbed
  // Drives the shared PlayerControlBar over the native <video> (Reddit/link, and the PiP
  // stream swap for embed sources) so it matches the Vimeo/TikTok bar instead of leaving the
  // browser's own native controls, which look different from the rest of the hub.
  const [nativePlaying, setNativePlaying] = useState(true)
  const [nativeMuted, setNativeMuted] = useState(false)
  const [nativeDuration, setNativeDuration] = useState(0)

  usePlaybackAttach(videoRef, data?.playback ?? null, localUrl)

  // Once the PiP stream swap mounts its <video>, fire the actual PiP request when it can play.
  useEffect(() => {
    if (!pipStream) return
    const v = videoRef.current
    if (!v) return
    const onReady = () => { void v.requestPictureInPicture?.().catch(() => {}) }
    if (v.readyState >= 1) onReady()
    else v.addEventListener('loadedmetadata', onReady, { once: true })
    return () => v.removeEventListener('loadedmetadata', onReady)
  }, [pipStream])

  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled
  const togglePip = () => {
    const v = videoRef.current
    if (v && document.pictureInPictureElement === v) { void document.exitPictureInPicture().catch(() => {}); return }
    if (hasNativeVideo && v) { void v.requestPictureInPicture?.().catch(() => {}); return }
    setPipStream(true)   // embed → swap to a streamed <video>, PiP fires on ready
  }

  // If we arrived here by expanding this same video from the mini-player, adopt it: clear the
  // dock so the mini-bar doesn't re-appear (and re-play) when we navigate on.
  useEffect(() => {
    if (pb.track?.source === source && pb.track?.videoId === id) pb.clearDock()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Minimize to the app mini-player: dock a real <video> (via /api/vstream for embed sources,
  // which the mini-bar can't play as an iframe) and step back to the source's home.
  const minimize = () => {
    if (!data?.item) return
    const at = videoRef.current?.currentTime ?? 0
    pb.dock([{
      videoId: id, source, title: data.item.title, author: data.item.creator?.name ?? null,
      thumbnail: data.item.thumbnailUrl ? proxyImg(data.item.thumbnailUrl) : undefined,
      // Raw creator-avatar URL — the mini-bar's CreatorAvatar proxies it through /api/img.
      channelThumb: data.item.creator?.avatarUrl ?? null,
      // A saved offline copy docks its local file (it's exactly why embedUrl is null for
      // saved TikTok/Vimeo — don't make /api/vstream re-download what's already on disk);
      // then TikTok/Vimeo dock their embed iframe (instant, reliable); every other source
      // docks a real <video> off /api/vstream.
      ...(localUrl ? { streamVideoUrl: localUrl } : embedUrl ? { embedUrl } : { streamVideoUrl: vstreamUrl }),
      durationSec: data.item.durationSec ?? null,
      expandTo: `/videos/${source}/watch/${id}`,
    }], 0, at)
    navigate(`/videos/${source}`)
  }

  // Playback second for the transcript's follow-along highlight. Native <video> only —
  // embed iframes (TikTok/Vimeo online) expose no time, so it stays -1 and no line
  // highlights; tapping a line still seeks when a native video exists.
  const [currentSec, setCurrentSec] = useState(-1)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => setCurrentSec(v.currentTime)
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [showEmbed, id])
  const seekTo = (sec: number) => {
    const v = videoRef.current
    if (v) { v.currentTime = sec; void v.play().catch(() => {}) }
  }
  const toggleNativePlay = () => { const v = videoRef.current; if (!v) return; v.paused ? void v.play().catch(() => {}) : v.pause() }

  // Advances to the playlist's next entry. There's no algorithmic "up next" for hub sources,
  // so outside a playlist context this is simply never triggered.
  function goToNext() {
    setCountdown(null)
    if (pq.next && pq.next.videoSource !== 'mine' && pq.playlistId) {
      navigate(playlistWatchHref(pq.next.videoSource, pq.next.videoId, pq.playlistId, pq.nextIndex))
    }
  }
  function onVideoEnded() {
    if (autoplay && pq.active && pq.next) setCountdown({ secondsLeft: AUTOPLAY_COUNTDOWN_SEC, total: AUTOPLAY_COUNTDOWN_SEC })
  }
  useEffect(() => {
    if (!countdown) return
    if (countdown.secondsLeft <= 0) { goToNext(); return }
    const t = setTimeout(() => setCountdown(c => (c ? { ...c, secondsLeft: c.secondsLeft - 1 } : null)), 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown])

  // Resume position + periodic watch-state sync (10s cadence + unmount flush).
  const lastSent = useRef(0)
  useEffect(() => {
    const video = videoRef.current
    if (!video || !item) return
    const snapshot = {
      title: item.title, thumbnailUrl: item.thumbnailUrl, creatorId: item.creator?.id ?? null,
      creatorName: item.creator?.name ?? null, durationSec: item.durationSec, isAdult: item.isAdult,
    }
    const onTime = () => {
      const now = Date.now()
      if (now - lastSent.current < 10_000) return
      lastSent.current = now
      const completed = video.duration > 0 && video.currentTime / video.duration > 0.9
      void putWatchState(source, id, Math.floor(video.currentTime), completed, snapshot).catch(() => {})
    }
    video.addEventListener('timeupdate', onTime)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      if (video.currentTime > 5) {
        const completed = video.duration > 0 && video.currentTime / video.duration > 0.9
        void putWatchState(source, id, Math.floor(video.currentTime), completed, snapshot).catch(() => {})
      }
    }
  }, [source, id, item])

  const saveMutation = useMutation({
    mutationFn: () => saveVideo(source, id, 'video'),
    onSuccess: () => {
      toast.success('Saving for offline')
      void qc.invalidateQueries({ queryKey: ['videos-saves', source] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  })

  const creatorPath = useMemo(() => {
    if (!item?.creator?.id || !(source in HUB_PATHS)) return null
    return HUB_PATHS[source].creator(item.creator.id)
  }, [item, source])

  const { shareLink } = useShareLink()

  const { data: followsData } = useQuery({ queryKey: ['videos-follows'], queryFn: listFollows })
  const follow = followsData?.follows.find((f) => f.source === source && f.externalId.toLowerCase() === (item?.creator?.id ?? '').toLowerCase())
  const followMutation = useMutation({
    mutationFn: () => (follow ? removeFollow(follow.id) : addFollow(source, item!.creator!.id)),
    onSuccess: () => {
      toast.success(follow ? 'Unsubscribed' : 'Subscribed')
      void qc.invalidateQueries({ queryKey: ['videos-follows'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not update follow'),
  })

  if (isLoading) {
    return <PageContainer width="wide" className="flex justify-center py-24"><Spinner /></PageContainer>
  }
  if (error || !item) {
    return (
      <PageContainer width="wide" className="py-12">
        <Card variant="flat" className="p-6 text-sm text-muted-foreground">
          {error instanceof Error ? error.message : 'This video is not available.'}
        </Card>
      </PageContainer>
    )
  }
  if (onlineOnly) {
    return (
      <PageContainer width="wide" className="py-12">
        <Card variant="flat" className="p-6 text-sm text-muted-foreground">
          This video is not saved offline. Switch to Online to stream it, or save it offline while online.
        </Card>
      </PageContainer>
    )
  }

  const saveState = save?.status
  const badge = SOURCE_META[source]
  // Same panel as YouTube's: the queue/watch-next content is the first (default) tab,
  // then Transcript / AI Summary / Comments. Each tab is capability-gated: Transcript +
  // AI Summary drop off where the platform's videos never carry captions (TikTok,
  // Reddit), where they'd always render empty, and Comments drops off where there's no
  // comments API at all (TikTok).
  const tabs: Array<{ key: SideTab; label: string }> = [
    { key: 'upnext', label: pq.active && pq.playlistId ? 'Queue' : 'Up next' },
  ]
  if (capabilities?.transcript !== false) {
    tabs.push({ key: 'transcript', label: 'Transcript' })
  }
  if (capabilities?.comments) tabs.push({ key: 'comments', label: item.commentsCount ? `Comments (${item.commentsCount})` : 'Comments' })

  return (
   <WatchCinema art={item.thumbnailUrl ? proxyImg(item.thumbnailUrl) : null}>
    <PageContainer width="full" className="py-6">
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 xl:grid-cols-[1fr_400px]">
      {/* Main column: player with the vertical action rail beside it, then a calm title
          block (one title, creator subtitle, readable description - nothing else).
          Vertical (TikTok/Reels) videos are capped by HEIGHT so the info stays visible. */}
      <div className="min-w-0 space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        {/* design-ok(adhoc-container): viewport-height-derived cap so an ultrawide column
            can't make the video taller than the screen; the rail hugs its right edge. */}
        <div className={cn('min-w-0 flex-1', item.vertical ? 'flex justify-center' : 'lg:max-w-[calc(78vh*(16/9))]')}>
          <div className={cn('relative', !item.vertical && 'overflow-hidden rounded-card shadow-2xl')}>
            {showEmbed ? (
              source === 'vimeo' ? (
                <VimeoWatchPlayer embedUrl={embedUrl!} title={item.title} vertical={!!item.vertical} />
              ) : source === 'tiktok' ? (
                <TikTokWatchPlayer embedUrl={embedUrl!} title={item.title} vertical={!!item.vertical} />
              ) : (
                <iframe
                  src={embedUrl!}
                  title={item.title}
                  allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                  allowFullScreen
                  className={item.vertical
                    ? 'aspect-[9/16] h-[min(64vh,600px)] rounded-card border-0 bg-black'
                    : 'aspect-video w-full border-0 bg-black'}
                />
              )
            ) : (
              <div ref={nativeWrapRef} className={cn('group relative overflow-hidden bg-black', item.vertical && 'rounded-card',
                item.vertical ? 'aspect-[9/16] h-[min(64vh,600px)]' : 'aspect-video w-full')}>
                <video
                  ref={videoRef}
                  src={pipStream ? vstreamUrl : undefined}
                  autoPlay
                  playsInline
                  poster={item.thumbnailUrl ?? undefined}
                  onEnded={onVideoEnded}
                  onPlay={() => setNativePlaying(true)}
                  onPause={() => setNativePlaying(false)}
                  onDurationChange={(e) => setNativeDuration(e.currentTarget.duration || 0)}
                  onVolumeChange={(e) => setNativeMuted(e.currentTarget.muted)}
                  className="size-full"
                />
                <PlayerClickToggle playing={nativePlaying} onToggle={toggleNativePlay} />
                <PlayerControlBar playing={nativePlaying} muted={nativeMuted}
                  position={currentSec < 0 ? 0 : currentSec} duration={nativeDuration}
                  onToggle={toggleNativePlay}
                  onToggleMute={() => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setNativeMuted(v.muted) }}
                  onSeek={seekTo}
                  onFullscreen={toggleNativeFullscreen} />
              </div>
            )}
            {countdown && pq.next && (
              <AutoplayCountdown
                nextItem={{ title: pq.next.title, author: pq.next.author, videoId: pq.next.videoSource === 'youtube' ? pq.next.videoId : undefined, thumbnailUrl: pq.next.videoSource === 'youtube' ? undefined : pq.next.thumbnailUrl }}
                secondsLeft={countdown.secondsLeft} total={countdown.total}
                onCancel={() => setCountdown(null)}
                onPlayNow={goToNext}
              />
            )}
          </div>
        </div>

        {/* Vertical icon rail beside the player: like/save/share/playlist/⋯ as unlabeled
            circles, so the title block keeps the full column width. */}
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 lg:w-10 lg:flex-col lg:flex-nowrap lg:justify-start">
          {/* design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop */}
          <Button size="icon" onClick={() => toggleCollection('liked', collectionSnapshot())}
            title={liked ? 'Remove from Liked' : 'Like'} aria-label={liked ? 'Remove from Liked' : 'Like'}
            className={cn('size-10 rounded-full bg-white/10 text-foreground/85 shadow-none hover:bg-white/15', liked && 'text-[var(--yt-accent-fg)]')}>
            <Heart className={cn('size-4', liked && 'fill-current')} />
          </Button>
          {/* design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop */}
          <Button size="icon" onClick={(saveMutation.isPending || saveState === 'pending' || saveState === 'downloading') ? undefined : () => saveMutation.mutate()}
            disabled={saveState === 'ready'} aria-label="Save offline"
            title={saveState === 'ready' ? 'Saved offline' : 'Save offline: this server downloads the video so you can watch it later without streaming.'}
            className={cn('size-10 rounded-full bg-white/10 text-foreground/85 shadow-none hover:bg-white/15', saveState === 'ready' && 'text-[var(--yt-accent-fg)] disabled:opacity-100')}>
            {saveState === 'ready' ? <Check className="size-4" />
              : (saveState === 'pending' || saveState === 'downloading') ? <Spinner className="size-4" />
              : <HardDriveDownload className="size-4" />}
          </Button>
          {/* design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop */}
          <Button size="icon" onClick={() => shareLink(item.url, { label: 'Link' })}
            title={`Share the ${badge.label} link`} aria-label="Share"
            className="size-10 rounded-full bg-white/10 text-foreground/85 shadow-none hover:bg-white/15">
            <Share2 className="size-4" />
          </Button>
          {/* design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop */}
          <span className="grid size-10 place-items-center rounded-full bg-white/10 transition-colors hover:bg-white/15" title="Add to playlist">
            <AddToPlaylistPill compact video={{
              videoId: id, title: item.title, author: item.creator?.name ?? undefined, channelId: item.creator?.id ?? undefined,
              durationSec: item.durationSec ?? undefined, videoSource: source, thumbnailUrl: item.thumbnailUrl,
            }} />
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop */}
              <Button size="icon" title="More actions" aria-label="More actions"
                className="size-10 rounded-full bg-white/10 text-foreground/85 shadow-none hover:bg-white/15 data-[state=open]:bg-white/20 data-[state=open]:text-foreground">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => toggleCollection('watch-later', collectionSnapshot())}>
                <Clock className={cn('size-4', watchLater && 'fill-current text-[var(--yt-accent-fg)]')} />
                {watchLater ? 'Remove from Watch Later' : 'Watch Later'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { const a = document.createElement('a'); a.href = vstreamUrl; a.download = `${item.title || 'video'}.mp4`; document.body.appendChild(a); a.click(); a.remove() }}>
                <Download className="size-4" /> Download
              </DropdownMenuItem>
              <DropdownMenuItem onClick={minimize}
                title="Keep playing in the mini-player while you browse. For TikTok/Vimeo this streams a direct copy (a few seconds to start).">
                <SquareArrowOutDownLeft className="size-4" /> Minimize to mini-player
              </DropdownMenuItem>
              {pipSupported && (
                <DropdownMenuItem onClick={togglePip}
                  title="Pop the video into a floating window while you keep browsing. For TikTok/Vimeo this streams a direct copy (a few seconds to start).">
                  <PictureInPicture2 className="size-4" /> Picture-in-picture
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setPodcastOpen(true)}>
                <Mic className="size-4" /> Create podcast
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}>
                <ExternalLink className="size-4" /> Open on {badge.label}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        </div>

        <div className="space-y-4">
          {/* Calm full-width header: eyebrow + title + creator subtitle. Actions live in
              the vertical rail beside the player. */}
          <div className="min-w-0 space-y-1.5">
              {(item.viewsText || item.likesText || item.publishedText || item.publishedAt) && (
                <p className="text-overline text-white/50">
                  {[item.viewsText, item.likesText, item.publishedText ?? fmtAge(item.publishedAt)].filter(Boolean).join(' · ')}
                </p>
              )}
              {/* design-ok(raw-h1-in-pages): video title is content on a full-bleed watch surface, not page chrome */}
              <h1 className="text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">{item.title}</h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1.5">
                {item.creator && (
                  <span className="flex items-center gap-2">
                    <CreatorAvatar title={item.creator.name} src={item.creator.avatarUrl} className="size-6 text-[10px] ring-1 ring-white/15" />
                    {creatorPath ? (
                      <Link to={creatorPath} className="text-sm font-medium text-white/80 transition-colors hover:text-[var(--yt-accent-fg)]">{item.creator.name}</Link>
                    ) : (
                      <span className="text-sm font-medium text-white/80">{item.creator.name}</span>
                    )}
                  </span>
                )}
                {item.creator && (follow ? (
                  // design-ok(glass-on-plain-bg): compact pill over the UltraBlur cinema backdrop
                  <Button size="sm" onClick={() => followMutation.mutate()} disabled={followMutation.isPending} title="Subscribed. Click to unsubscribe"
                    className="h-7 rounded-full bg-white/10 px-3 text-xs font-semibold text-foreground/75 shadow-none hover:bg-destructive/20 hover:text-destructive disabled:opacity-60">
                    {followMutation.isPending ? <Spinner className="size-3" /> : <Check className="size-3.5" />} Subscribed
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => followMutation.mutate()} disabled={followMutation.isPending} title="Subscribe"
                    className="h-7 rounded-full bg-[var(--yt-accent)] px-3 text-xs font-semibold text-[var(--yt-accent-contrast,white)] shadow-none hover:bg-[var(--yt-accent-hover)] disabled:opacity-60">
                    {followMutation.isPending ? <Spinner className="size-3 text-current" /> : <Plus className="size-3.5" />} Subscribe
                  </Button>
                ))}
              </div>
            </div>
          <DescriptionCard views={null} description={item.description ?? null} />
          {/* AI summary lives inline with the description it condenses, not as a rail tab. */}
          {capabilities?.transcript !== false && (
            <>
              <button onClick={() => setSummaryOpen(v => !v)}
                className={cn('-mt-3 flex items-center gap-1 px-1 text-xs font-semibold transition-colors',
                  summaryOpen ? 'text-[var(--yt-accent-fg)]' : 'text-muted-foreground hover:text-foreground')}>
                <Sparkles className="size-3" /> {summaryOpen ? 'Hide AI summary' : 'AI summary'}
              </button>
              {summaryOpen && (
                <div className="rounded-card bg-white/[0.04] p-4 ring-1 ring-white/10">
                  <SummaryTab videoId={id} initial={null} source={source} />
                </div>
              )}
            </>
          )}
        </div>

        <CreatePodcastDialog open={podcastOpen} onClose={() => setPodcastOpen(false)}
          videos={[{ videoId: id, title: item.title, author: item.creator?.name, source, url: item.url }]}
          sourceLabel={item.creator?.name ?? badge.label}
          sourceRef={`${source}:${id}`}
          suggestedShowName={item.creator?.name ?? item.title}
          defaultLabel={item.title} />
      </div>

      {/* Side column: ONE tabbed rail - the queue/watch-next content is the first
          (default) tab, not modules stacked under the panel. */}
      <aside className="min-w-0 xl:sticky xl:top-6 xl:flex xl:h-[calc(100dvh-7rem)] xl:min-h-0 xl:flex-col xl:self-start">
        <SidePanelShell tabs={tabs} active={tab} onChange={setExplicitTab}
          action={tab === 'upnext' && pq.active && pq.playlistId ? (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 pr-1 text-xs font-medium text-muted-foreground">
              Autoplay
              <button onClick={() => setAutoplay(a => !a)} role="switch" aria-checked={autoplay}
                className={cn('relative h-5 w-9 rounded-full transition-colors', autoplay ? 'bg-[var(--yt-accent)]' : 'bg-muted-foreground/30')}>
                <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-transform', autoplay ? 'translate-x-4' : 'translate-x-0.5')} />
              </button>
            </label>
          ) : undefined}>
          {tab === 'upnext' && (
            pq.active && pq.playlistId ? (
              <PlaylistQueuePanel playlistId={pq.playlistId} playlistName={pq.playlistName} videos={pq.videos} pos={pq.pos} />
            ) : (
              <div className="space-y-5 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
                {capabilities?.related && <RelatedVideosCard source={source} excludeId={id} />}
                {item.creator && <MoreFromCreatorCard source={source} creatorId={item.creator.id} excludeId={id} />}
                {!capabilities?.related && !item.creator && <Empty>Nothing queued.</Empty>}
              </div>
            )
          )}
          {tab === 'transcript' && <TranscriptTab videoId={id} source={source} onSeek={seekTo} currentSec={currentSec} />}
          {tab === 'comments' && <GenericCommentsTab source={source} id={id} />}
        </SidePanelShell>
      </aside>
      </div>
    </PageContainer>
   </WatchCinema>
  )
}

function GenericCommentsTab({ source, id }: { source: VideoSource; id: string }) {
  const { data, isPending } = useQuery({ queryKey: ['videos-comments', source, id], queryFn: () => getSourceComments(source, id) })
  const comments = data?.comments ?? []
  if (isPending) return <Centered><Spinner /> Loading comments…</Centered>
  if (!comments.length) return <Empty>No comments.</Empty>
  return (
    <div className="max-h-[520px] space-y-4 overflow-y-auto pr-1 xl:max-h-none xl:min-h-0 xl:flex-1">
      {comments.map((cm, i) => (
        <div key={i} className="text-sm">
          <p className="font-medium text-foreground">{cm.author}
            {cm.likes && <span className="ml-2 text-xs font-normal text-muted-foreground">{cm.likes} points</span>}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-foreground/90">{cm.text}</p>
        </div>
      ))}
    </div>
  )
}

/** Platform-ranked "watch next" shelf (capabilities.related — Vimeo's related listing). */
function RelatedVideosCard({ source, excludeId }: { source: VideoSource; excludeId: string }) {
  const { data } = useQuery({
    queryKey: ['videos-related', source, excludeId],
    queryFn: () => getSourceRelated(source, excludeId),
    staleTime: 5 * 60_000,
  })
  const items = (data?.items ?? []).filter((i) => i.id !== excludeId).slice(0, 12)
  if (!items.length) return null
  return (
    <div>
      <div className="mb-2 px-1"><h3 className="text-overline text-white/60">Related videos</h3></div>
      <div className="space-y-1">
        {items.map((i) => (
          <Link key={i.id} to={HUB_PATHS[i.source].watch(i.id)} className="group flex gap-2.5 rounded-card p-1.5 transition-colors hover:bg-accent/50">
            <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-card shadow-sm ring-1 ring-white/10 sm:w-36">
              <VideoPlaceholderArt source={i.source} />
              {i.thumbnailUrl && <img src={proxyImg(i.thumbnailUrl)} alt="" loading="lazy" className="relative size-full object-cover transition group-hover:scale-105" />}
            </div>
            <div className="min-w-0 flex-1 py-0.5">
              <p className="line-clamp-2 text-sm font-semibold leading-snug">{i.title}</p>
              {(i.creator?.name || i.viewsText) && (
                <p className="mt-1 truncate text-xs text-muted-foreground">{[i.creator?.name, i.viewsText].filter(Boolean).join(' · ')}</p>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}

/** "Up next" counterpart for generic sources: this creator's other videos. */
function MoreFromCreatorCard({ source, creatorId, excludeId }: { source: VideoSource; creatorId: string; excludeId: string }) {
  const { data } = useQuery({ queryKey: ['videos-creator', source, creatorId], queryFn: () => getSourceCreator(source, creatorId) })
  const items = (data?.videos.items ?? []).filter((i) => i.id !== excludeId).slice(0, 15)
  return (
    <div>
      <div className="mb-2 px-1"><h3 className="text-overline text-white/60">More from this creator</h3></div>
      <div className="space-y-1">
        {items.map((i) => (
          <Link key={i.id} to={HUB_PATHS[i.source].watch(i.id)} className="group flex gap-2.5 rounded-card p-1.5 transition-colors hover:bg-accent/50">
            <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-card shadow-sm ring-1 ring-white/10 sm:w-36">
              <VideoPlaceholderArt source={i.source} />
              {i.thumbnailUrl && <img src={proxyImg(i.thumbnailUrl)} alt="" loading="lazy" className="relative size-full object-cover transition group-hover:scale-105" />}
            </div>
            <div className="min-w-0 flex-1 py-0.5">
              <p className="line-clamp-2 text-sm font-semibold leading-snug">{i.title}</p>
              {i.publishedText && <p className="mt-1 truncate text-xs text-muted-foreground">{i.publishedText}</p>}
            </div>
          </Link>
        ))}
        {items.length === 0 && <p className="px-1 py-4 text-xs text-muted-foreground">Nothing else from this creator yet.</p>}
      </div>
    </div>
  )
}
