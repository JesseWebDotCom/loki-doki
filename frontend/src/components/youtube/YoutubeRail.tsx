import { NavLink, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Home, Clock, Heart, History, Download, ListVideo, Settings2, SlidersHorizontal, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
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

export function YoutubeRail({ onManage }: { onManage: () => void }) {
  const { data: subs = [] } = useQuery({ queryKey: ['yt-subs'], queryFn: getSubscriptions })

  return (
    <nav className="hidden h-full min-h-0 w-60 shrink-0 flex-col overflow-y-auto overscroll-none border-r border-border/40 px-3 py-5 lg:flex">
      <AppRailHeader
        title="YouTube"
        className="mb-4"
      />
      <RailLink to="/youtube" icon={Home} label="Home" end />

      <SectionLabel>Your Library</SectionLabel>
      <RailLink to="/youtube/history" icon={History} label="History" />
      <RailLink to="/youtube/playlists" icon={ListVideo} label="Playlists" />
      <RailLink to="/youtube/watch-later" icon={Clock} label="Watch Later" />
      <RailLink to="/youtube/liked" icon={Heart} label="Liked Videos" />
      <RailLink to="/youtube/offline" icon={Download} label="Offline" />

      <div className="mb-1 mt-5 flex items-center justify-between px-3">
        <Link to="/youtube/subscriptions"
          className="text-overline text-muted-foreground/60 transition-colors hover:text-foreground">
          Subscriptions
        </Link>
        <Button variant="ghost" size="icon-sm" onClick={onManage} title="Manage channels" aria-label="Manage channels"
          className="text-muted-foreground/70 hover:text-foreground">
          <Settings2 className="size-3.5" />
        </Button>
      </div>
      {subs.length > 0 ? (
        <div className="space-y-0.5">
          {subs.slice(0, 8).map(s => (
            <Link key={s.id} to={`/youtube/channel/${encodeURIComponent(s.externalId)}`}
              className="flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
              <ChannelAvatar title={s.title} src={s.thumbnailUrl} className="size-6 text-[10px] ring-1 ring-border/40" />
              <span className="truncate">{s.title}</span>
            </Link>
          ))}
          {subs.length > 8 && (
            <Link to="/youtube/subscriptions"
              className="block rounded-control px-2.5 py-1.5 text-xs font-medium text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground">
              Show all ({subs.length})
            </Link>
          )}
        </div>
      ) : (
        <Button variant="ghost" size="sm" onClick={onManage}
          className="justify-start px-3 font-normal text-xs text-muted-foreground/70 hover:text-foreground">
          + Add channels &amp; playlists
        </Button>
      )}

      <RailLink to="/youtube/settings" icon={SlidersHorizontal} label="Settings" className="mt-5" />
    </nav>
  )
}
