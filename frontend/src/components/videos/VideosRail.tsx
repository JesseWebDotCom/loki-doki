import { NavLink, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Clapperboard, Home, Clock, Heart, History, Download, ListVideo, Link2, MessagesSquare, Music2, Play, Sparkles, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { ChannelAvatar } from '@/components/youtube/media'
import { getSubscriptions } from '@/lib/youtube/api'

function RailLink({ to, icon: Icon, label, end, className }: { to: string; icon: LucideIcon; label: string; end?: boolean; className?: string }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
        isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        className,
      )}>
      <Icon className="size-[18px]" /> {label}
    </NavLink>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 mt-5 px-3 text-overline text-muted-foreground/60">{children}</p>
}

export function VideosRail() {
  const { data: subs = [] } = useQuery({ queryKey: ['yt-subs'], queryFn: getSubscriptions })

  return (
    <nav className="hidden h-full min-h-0 w-60 shrink-0 flex-col overflow-y-auto overscroll-none border-r border-border/40 px-3 py-5 lg:flex">
      <AppRailHeader
        title="Videos"
        className="mb-4"
      />
      <RailLink to="/videos" icon={Home} label="Home" end />
      <RailLink to="/videos/clip" icon={Link2} label="Clip a Link" />
      <RailLink to="/videos/create" icon={Sparkles} label="Create" />

      {/* Sources grow as providers land (Reddit, TikTok, Vimeo). */}
      <SectionLabel>Sources</SectionLabel>
      <RailLink to="/videos/youtube" icon={Play} label="YouTube" end />
      <RailLink to="/videos/reddit" icon={MessagesSquare} label="Reddit" end />
      <RailLink to="/videos/tiktok" icon={Music2} label="TikTok" end />
      <RailLink to="/videos/vimeo" icon={Clapperboard} label="Vimeo" end />

      <SectionLabel>Your Library</SectionLabel>
      <RailLink to="/videos/history" icon={History} label="History" />
      <RailLink to="/videos/playlists" icon={ListVideo} label="Playlists" />
      <RailLink to="/videos/watch-later" icon={Clock} label="Watch Later" />
      <RailLink to="/videos/liked" icon={Heart} label="Liked Videos" />
      <RailLink to="/videos/offline" icon={Download} label="Offline" />

      <Link to="/videos/youtube/subscriptions"
        className="mb-1 mt-5 block px-3 text-overline text-muted-foreground/60 transition-colors hover:text-foreground">
        Subscriptions
      </Link>
      {subs.length > 0 ? (
        <div className="space-y-0.5">
          {subs.slice(0, 8).map(s => (
            <Link key={s.id} to={`/videos/youtube/channel/${encodeURIComponent(s.externalId)}`}
              className="flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
              <ChannelAvatar title={s.title} src={s.thumbnailUrl} className="size-6 text-[10px] ring-1 ring-border/40" />
              <span className="truncate">{s.title}</span>
            </Link>
          ))}
          {subs.length > 8 && (
            <Link to="/videos/youtube/subscriptions"
              className="block rounded-control px-2.5 py-1.5 text-xs font-medium text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground">
              Show all ({subs.length})
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
