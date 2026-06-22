import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Sparkles, BookmarkPlus, Download, Heart, Clock, Loader2, Search, Smartphone, Mic,
} from 'lucide-react'
import { ShieldCheck, Headphones } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { useYoutubeUI } from '@/components/youtube/YoutubeLayout'
import { VideoPlayer, type VideoPlayerHandle } from '@/components/youtube/VideoPlayer'
import { UpNextRow } from '@/components/youtube/VideoCard'
import { CreatePodcastDialog } from '@/components/youtube/CreatePodcastDialog'
import { useUnsubscribeConfirm } from '@/components/youtube/UnsubscribeDialog'
import { ChannelAvatar } from '@/components/youtube/media'
import { useYtFeed } from '@/lib/youtube/useData'
import {
  getVideoMeta, summarize, getTranscriptText, getRelated, getSponsorSegments,
  addSubscription, deleteSubscription,
} from '@/lib/youtube/api'
import { itToItem, isShort } from '@/lib/youtube/types'
import { parseChapters } from '@/lib/youtube/chapters'
import { parseVtt, type TranscriptLine } from '@/lib/youtube/transcript'
import { toggleCollection, useCollection } from '@/lib/youtube/collections'

type SideTab = 'transcript' | 'summary'

const PRIVACY_KEY = 'yt.privacy'
const AUDIO_KEY = 'yt.audioOnly'
const SB_LABELS: Record<string, string> = {
  sponsor: 'sponsor', selfpromo: 'self-promo', interaction: 'reminder',
  intro: 'intro', outro: 'outro', preview: 'recap', music_offtopic: 'non-music',
}

export function WatchPage() {
  const { videoId = '' } = useParams()
  const [params] = useSearchParams()
  const localKind = (params.get('k') as 'audio' | 'video' | null) ?? undefined
  const navigate = useNavigate()
  const ui = useYoutubeUI()
  const playerRef = useRef<VideoPlayerHandle>(null)
  const [tab, setTab] = useState<SideTab>('transcript')
  const [autoplay, setAutoplay] = useState(true)

  const { data: meta, isPending } = useQuery({ queryKey: ['yt-video', videoId], queryFn: () => getVideoMeta(videoId), enabled: !!videoId })
  const { items } = useYtFeed()
  const online = !localKind

  // Privacy proxy: stream through our server instead of the YouTube embed. Opt-in
  // (slower to start, currently caps at 720p) and remembered across the session.
  const [privacy, setPrivacy] = useState(() => localStorage.getItem(PRIVACY_KEY) === '1')
  const togglePrivacy = () => setPrivacy(p => { const n = !p; try { localStorage.setItem(PRIVACY_KEY, n ? '1' : '0') } catch { /* quota */ } return n })
  // Audio-only: stream just the audio (thumbnail stays as poster). Remembered per session.
  const [audioOnly, setAudioOnly] = useState(() => localStorage.getItem(AUDIO_KEY) === '1')
  const toggleAudioOnly = () => setAudioOnly(p => { const n = !p; try { localStorage.setItem(AUDIO_KEY, n ? '1' : '0') } catch { /* quota */ } return n })

  // Real "Up next": YouTube's own related videos (InnerTube), falling back to the feed
  // when offline or when related comes back empty.
  const { data: related = [] } = useQuery({ queryKey: ['yt-related', videoId], queryFn: () => getRelated(videoId), enabled: online && !!videoId })
  // SponsorBlock segments — auto-skipped + marked on the scrubber (online only).
  const { data: segments = [] } = useQuery({ queryKey: ['yt-sb', videoId], queryFn: () => getSponsorSegments(videoId), enabled: online && !!videoId })

  // The card that linked here passes the channel's name/avatar (e.g. search results,
  // which aren't subscribed so the API can't supply them) — used as a fallback.
  const navState = (useLocation().state ?? {}) as { title?: string | null; author?: string | null; channelThumb?: string | null }
  const feedItem = items.find(i => i.videoId === videoId)
  // A short opened in the full watch view — offer a jump back to the vertical feed.
  const isShortVid = online && !!feedItem && isShort(feedItem)
  const title = meta?.title || feedItem?.title || navState.title || 'Video'
  const author = meta?.author ?? feedItem?.author ?? navState.author ?? null
  const channelThumb = meta?.channelThumb ?? feedItem?.channelThumb ?? navState.channelThumb ?? null
  const resumeSec = meta?.positionSec ?? 0

  const upNext = useMemo(() => {
    if (related.length) return related.map(itToItem).filter(i => i.videoId !== videoId).slice(0, 15)
    return items.filter(i => i.videoId !== videoId).slice(0, 15)
  }, [related, items, videoId])

  // Chapters parsed from the description (creators list them as timestamped lines).
  const chapters = useMemo(() => parseChapters(meta?.description), [meta?.description])

  // Current playback second — drives the transcript's follow-along highlight.
  const [currentSec, setCurrentSec] = useState(0)
  const videoMeta = useMemo(() => ({
    title: meta?.title ?? feedItem?.title ?? navState.title ?? undefined,
    author, channelId: meta?.channelId ?? null, durationSec: meta?.durationSec ?? null,
  }), [meta?.title, meta?.channelId, meta?.durationSec, author, feedItem?.title, navState.title])

  function onEnded() {
    if (autoplay && upNext[0]) navigate(`/youtube/watch/${upNext[0].videoId}${upNext[0].localKind ? `?k=${upNext[0].localKind}` : ''}`)
  }

  return (
    <div className="mx-auto grid max-w-[1600px] grid-cols-1 gap-6 px-4 py-6 sm:px-6 xl:grid-cols-[1fr_400px]">
      {/* Main column */}
      <div className="min-w-0 space-y-5">
        {isPending ? (
          <div className="aspect-video w-full animate-pulse rounded-2xl bg-muted" />
        ) : (
          <VideoPlayer
            ref={playerRef} key={`${videoId}:${privacy}:${audioOnly}`} videoId={videoId} localKind={localKind}
            resumeSec={resumeSec} onEnded={onEnded}
            privacyProxy={online && privacy} audioOnly={online && audioOnly}
            skipSegments={online ? segments : undefined}
            onSkip={(cat) => toast.info(`Skipped ${SB_LABELS[cat] ?? cat}`)}
            chapters={chapters}
            onTime={(s) => setCurrentSec(Math.floor(s))}
            videoMeta={videoMeta}
          />
        )}

        {online && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button onClick={togglePrivacy} title="Stream through this server so Google never sees you (≤720p)."
              className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium transition-colors',
                privacy ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground')}>
              <ShieldCheck className={cn('size-3.5', privacy && 'fill-current')} /> Private stream
            </button>
            <button onClick={toggleAudioOnly} title="Play just the audio to save bandwidth — the thumbnail stays as the poster."
              className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium transition-colors',
                audioOnly ? 'border-sky-500/30 bg-sky-500/10 text-sky-400' : 'border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground')}>
              <Headphones className="size-3.5" /> Audio only
            </button>
            {isShortVid && (
              <Link to={`/youtube/shorts/${videoId}`}
                className="flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <Smartphone className="size-3.5" /> Shorts view
              </Link>
            )}
            {segments.length > 0 && (
              <span className="ml-auto flex items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1.5 font-medium text-amber-500/90"
                title="SponsorBlock segments are skipped automatically.">
                <ShieldCheck className="size-3.5" /> Skips {segments.length} sponsor{segments.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}

        <InfoPanel videoId={videoId} title={title} author={author} channelThumb={channelThumb} meta={meta}
          localKind={localKind} onSummary={() => setTab('summary')} />
      </div>

      {/* Side column */}
      <aside className="min-w-0 space-y-5">
        <SidePanel
          videoId={videoId} tab={tab} setTab={setTab} currentSec={currentSec}
          onSeek={(sec) => playerRef.current?.seek(sec)} initialSummary={meta?.summary ?? null}
        />
        <section className="rounded-2xl border border-border/50 bg-card/40 p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <h3 className="text-sm font-bold">Up next</h3>
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
        </section>
      </aside>
    </div>
  )
}

// ── Info panel ───────────────────────────────────────────────────────────────

function InfoPanel({ videoId, title, author, channelThumb, meta, localKind, onSummary }: {
  videoId: string
  title: string
  author: string | null
  channelThumb: string | null
  meta: import('@/lib/youtube/api').VideoMeta | undefined
  localKind?: 'audio' | 'video'
  onSummary: () => void
}) {
  const ui = useYoutubeUI()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [podcastOpen, setPodcastOpen] = useState(false)
  const [subbed, setSubbed] = useState(meta?.subscribed ?? false)
  const [subId, setSubId] = useState(meta?.subscriptionId ?? null)
  const [subBusy, setSubBusy] = useState(false)
  const channelId = meta?.channelId ?? null
  const description = meta?.description ?? null

  // Sync subscribe state once meta resolves (InfoPanel renders before meta loads).
  useEffect(() => {
    if (meta?.subscribed !== undefined) { setSubbed(meta.subscribed); setSubId(meta.subscriptionId ?? null) }
  }, [meta?.subscribed, meta?.subscriptionId])

  const snapshot = { videoId, title, author, channelId, durationSec: meta?.durationSec ?? null }
  const liked = useCollection('liked').some(v => v.videoId === videoId)
  const watchLater = useCollection('watch-later').some(v => v.videoId === videoId)

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
      <h1 className="text-xl font-black leading-tight tracking-tight sm:text-2xl">{title}</h1>

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
        {channelId && (
          <button onClick={toggleSub} disabled={subBusy}
            className={cn('flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-60',
              subbed ? 'bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive' : 'bg-[var(--yt-accent)] text-white hover:bg-[var(--yt-accent-hover)]')}>
            {subBusy && <Loader2 className="size-4 animate-spin" />}{subbed ? 'Subscribed' : 'Subscribe'}
          </button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onSummary}
            className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-violet-500/20 to-fuchsia-500/20 px-3.5 py-2 text-sm font-semibold text-violet-300 transition-colors hover:from-violet-500/30 hover:to-fuchsia-500/30">
            <Sparkles className="size-4" /> AI Summary
          </button>
          <Pill icon={Mic} label="Podcast" onClick={() => setPodcastOpen(true)} />
          <Pill icon={Heart} label="Like" active={liked} onClick={() => toggleCollection('liked', snapshot)} />
          <Pill icon={Clock} label="Watch Later" active={watchLater} onClick={() => toggleCollection('watch-later', snapshot)} />
          {!localKind && <Pill icon={BookmarkPlus} label="Save" onClick={() => ui.openSave(videoId, title)} />}
          <Pill icon={Download} label="Download" onClick={() => ui.openDownload(videoId, title, localKind)} />
        </div>
      </div>

      {description && (
        <div className="rounded-xl bg-muted/30 p-4 text-sm leading-relaxed text-foreground/85">
          <div className={cn('whitespace-pre-wrap', !expanded && 'line-clamp-3')}>{description}</div>
          <button onClick={() => setExpanded(e => !e)} className="mt-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
            {expanded ? 'Show less' : '…more'}
          </button>
        </div>
      )}

      <CreatePodcastDialog open={podcastOpen} onClose={() => setPodcastOpen(false)}
        videos={[{ videoId, title, author: author ?? undefined }]}
        sourceLabel={title} suggestedShowName={author ?? undefined} defaultLabel={title} />
    </div>
  )
}

function Pill({ icon: Icon, label, active, onClick }: { icon: typeof Heart; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={cn('flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-[var(--yt-accent-soft)] text-[var(--yt-accent-fg)]' : 'bg-muted text-foreground/80 hover:bg-muted/70')}>
      <Icon className={cn('size-4', active && 'fill-current')} /> {label}
    </button>
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
    <section className="rounded-2xl border border-border/50 bg-card/40">
      <div className="flex gap-1 border-b border-border/50 px-2 pt-2">
        {([['transcript', 'Transcript'], ['summary', 'AI Summary']] as [SideTab, string][]).map(([k, label]) => (
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
      </div>
    </section>
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

  if (isPending) return <Centered><Loader2 className="size-4 animate-spin" /> Fetching captions…</Centered>
  const prose = data?.prose ?? null
  if (!lines.length && !prose) return <Empty>No transcript available for this video.</Empty>

  const shown = ql ? lines.filter(l => l.text.toLowerCase().includes(ql)) : lines

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2">
        <Search className="size-3.5 text-muted-foreground" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search transcript" className="w-full bg-transparent text-sm outline-none" />
      </div>
      <div className="max-h-[440px] space-y-1 overflow-y-auto pr-1">
        {lines.length > 0 ? (
          shown.map((l, idx) => {
            const active = !ql && lines[activeIdx] === l
            return (
              <button key={`${l.sec}-${idx}`} ref={active ? activeRef : undefined} onClick={() => onSeek(l.sec)}
                className={cn('flex w-full gap-2.5 rounded-lg border-l-2 px-2 py-1.5 text-left text-sm transition-colors',
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
  if (isPending) return <Centered><Loader2 className="size-4 animate-spin" /> Summarizing…</Centered>
  if (!data) return <Empty>No summary available — this video has no captions to summarize.</Empty>
  return <div className="max-h-[480px] space-y-3 overflow-y-auto whitespace-pre-wrap px-1 text-sm leading-relaxed text-foreground/85">{data}</div>
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">{children}</div>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-sm text-muted-foreground/70">{children}</p>
}
