import { useMemo, useState } from 'react'
import { NavLink, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownUp, Clapperboard, Globe, Home, Clock, Heart, History, Download, ListVideo, Link2, MessagesSquare, Music2, Play, Sparkles, Video, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { getSubscriptions } from '@/lib/youtube/api'
import { getVideoSources, listFollows, type VideoSource } from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'

// One row in the unified Subscriptions list: YouTube subscriptions and generic follows
// (Reddit/TikTok/Vimeo) normalized to a single shape so they sort and render together.
interface UnifiedSub {
  key: string
  source: VideoSource
  title: string
  thumbnailUrl: string | null
  to: string
  updatedAt: number
}
type SubSort = 'recent' | 'name'

function creatorPath(source: VideoSource, externalId: string): string {
  const e = encodeURIComponent(externalId)
  switch (source) {
    case 'youtube': return `/videos/youtube/channel/${e}`
    case 'reddit': return `/videos/reddit/r/${e}`
    case 'tiktok': return `/videos/tiktok/creator/${e}`
    case 'vimeo': return `/videos/vimeo/channel/${e}`
    default: return `/videos/${source}/watch/${e}`
  }
}

const SOURCE_LINKS: Record<VideoSource, { to: string; icon: LucideIcon; label: string }> = {
  youtube: { to: '/videos/youtube', icon: Play, label: 'YouTube' },
  reddit: { to: '/videos/reddit', icon: MessagesSquare, label: 'Reddit' },
  tiktok: { to: '/videos/tiktok', icon: Music2, label: 'TikTok' },
  vimeo: { to: '/videos/vimeo', icon: Clapperboard, label: 'Vimeo' },
  // 'link' has no discovery surface; its rail target is the paste UI (the Clipper). It only
  // appears if an admin explicitly enables it; normally you reach it via the search bar.
  link: { to: '/videos/clip', icon: Globe, label: 'Other sites' },
}

function RailLink({ to, icon: Icon, label, end, className }: { to: string; icon: LucideIcon; label: string; end?: boolean; className?: string }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
        isActive ? 'bg-brand/10 text-brand' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        className,
      )}>
      <Icon className="size-[18px]" /> {label}
    </NavLink>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 mt-5 px-3 text-overline text-muted-foreground/60">{children}</p>
}

export function VideosRail({ variant = 'sidebar' }: { variant?: 'sidebar' | 'drawer' }) {
  const drawer = variant === 'drawer'
  const { data: subs = [] } = useQuery({ queryKey: ['yt-subs'], queryFn: getSubscriptions })
  const { data: followsData } = useQuery({ queryKey: ['videos-follows'], queryFn: listFollows, staleTime: 5 * 60_000 })
  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources, staleTime: 5 * 60_000 })
  // Before the sources list loads, show every source rather than none: an empty rail
  // on first paint looks broken, and this is just discovery-surface visibility, not a gate.
  const enabledSources = sourcesData
    ? sourcesData.sources.filter((s) => s.enabled).map((s) => s.source)
    : (Object.keys(SOURCE_LINKS) as VideoSource[])

  // Unified subscriptions: YouTube subs + every generic follow, one sorted list. The sort
  // (most-recently-updated vs A–Z) is toggled from the section header and remembered.
  const [subSort, setSubSort] = useState<SubSort>(
    () => (typeof localStorage !== 'undefined' && localStorage.getItem('videos.subSort') === 'name' ? 'name' : 'recent'))
  const toggleSubSort = () => setSubSort((s) => {
    const next: SubSort = s === 'recent' ? 'name' : 'recent'
    try { localStorage.setItem('videos.subSort', next) } catch { /* private mode */ }
    return next
  })
  const unifiedSubs = useMemo<UnifiedSub[]>(() => {
    const yt: UnifiedSub[] = subs.map((s) => ({
      key: `youtube:${s.id}`, source: 'youtube', title: s.title, thumbnailUrl: s.thumbnailUrl,
      to: creatorPath('youtube', s.externalId), updatedAt: s.lastFetchedAt ? Date.parse(s.lastFetchedAt) : 0,
    }))
    const gen: UnifiedSub[] = (followsData?.follows ?? []).map((f) => ({
      key: `${f.source}:${f.id}`, source: f.source, title: f.title, thumbnailUrl: f.thumbnailUrl ?? null,
      to: creatorPath(f.source, f.externalId), updatedAt: f.lastFetchedAt ? Date.parse(f.lastFetchedAt) : 0,
    }))
    const all = [...yt, ...gen]
    all.sort(subSort === 'name'
      ? (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      : (a, b) => (b.updatedAt - a.updatedAt) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
    return all
  }, [subs, followsData, subSort])

  return (
    <nav className={cn(
      'h-full min-h-0 shrink-0 flex-col overflow-y-auto overscroll-none px-3 py-5',
      drawer ? 'flex w-full' : 'hidden w-60 border-r border-border/40 lg:flex',
    )}>
      <AppRailHeader
        title="Videos"
        className="mb-4"
      />
      <RailLink to="/videos" icon={Home} label="Home" end />
      <RailLink to="/videos/clip" icon={Link2} label="Clip a Link" />

      {/* Which of these show up is admin-controlled (Videos → Settings → Sources). */}
      <SectionLabel>Sources</SectionLabel>
      <RailLink to="/videos/mine" icon={Video} label="Mine" />
      {enabledSources.map((s) => {
        const { to, icon, label } = SOURCE_LINKS[s]
        return <RailLink key={s} to={to} icon={icon} label={label} end />
      })}

      <SectionLabel>Your Library</SectionLabel>
      <RailLink to="/videos/history" icon={History} label="History" />
      <RailLink to="/videos/playlists" icon={ListVideo} label="Playlists" />
      <RailLink to="/videos/watch-later" icon={Clock} label="Watch Later" />
      <RailLink to="/videos/liked" icon={Heart} label="Liked Videos" />
      <RailLink to="/videos/offline" icon={Download} label="Offline" />
      <RailLink to="/videos/recap" icon={Sparkles} label="Year in Review" />

      <div className="mb-1 mt-5 flex items-center justify-between gap-2 px-3">
        <Link to="/videos/subscriptions" className="text-overline text-muted-foreground/60 transition-colors hover:text-foreground">Subscriptions</Link>
        {unifiedSubs.length > 1 && (
          <button type="button" onClick={toggleSubSort}
            title={subSort === 'recent' ? 'Sorted by most recent (click for A–Z)' : 'Sorted A–Z (click for most recent)'}
            className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50 transition-colors hover:text-foreground">
            <ArrowDownUp className="size-3" />
            {subSort === 'recent' ? 'Recent' : 'A–Z'}
          </button>
        )}
      </div>
      {unifiedSubs.length > 0 ? (
        <div className="space-y-0.5">
          {unifiedSubs.slice(0, 8).map((s) => (
            <Link key={s.key} to={s.to}
              className="flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
              <span className="relative shrink-0">
                <CreatorAvatar title={s.title} src={s.thumbnailUrl} className="size-6 text-[10px] ring-1 ring-border/40" />
                {/* Source dot so a Vimeo/TikTok/Reddit follow is distinguishable from a YouTube one. */}
                <span className={cn('absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background', SOURCE_META[s.source].dotClass)} />
              </span>
              <span className="truncate">{s.title}</span>
            </Link>
          ))}
          {unifiedSubs.length > 8 && (
            <Link to="/videos/subscriptions"
              className="block rounded-control px-2.5 py-1.5 text-xs font-medium text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground">
              Show all ({unifiedSubs.length})
            </Link>
          )}
        </div>
      ) : (
        <Link to="/videos/settings/channels"
          className="rounded-control px-3 py-1.5 text-xs font-normal text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground">
          + Add channels &amp; playlists
        </Link>
      )}
    </nav>
  )
}
