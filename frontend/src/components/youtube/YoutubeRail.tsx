import { NavLink, Link, useSearchParams, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Home, Clock, Heart, History, Download, Settings2, SlidersHorizontal, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { ChannelAvatar } from '@/components/youtube/media'
import { getSubscriptions } from '@/lib/youtube/api'

function RailLink({ to, icon: Icon, label, end }: { to: string; icon: LucideIcon; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
        isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}>
      <Icon className="size-[18px]" /> {label}
    </NavLink>
  )
}

/** A "Your Library" tab link that reflects ?tab= on the library route. */
function LibTab({ tab, icon: Icon, label }: { tab: string; icon: LucideIcon; label: string }) {
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const active = pathname.startsWith('/youtube/library') && (params.get('tab') ?? 'history') === tab
  return (
    <Link to={`/youtube/library?tab=${tab}`}
      className={cn('flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
      <Icon className="size-[18px]" /> {label}
    </Link>
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
      <RailLink to="/youtube/settings" icon={SlidersHorizontal} label="Settings" />

      <SectionLabel>Library</SectionLabel>
      <LibTab tab="history" icon={History} label="History" />
      <LibTab tab="watch-later" icon={Clock} label="Watch Later" />
      <LibTab tab="liked" icon={Heart} label="Liked Videos" />
      <LibTab tab="saved" icon={Download} label="Saved offline" />

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
    </nav>
  )
}
