import { LogOut, RefreshCw, Square, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import type { useWatchTogether } from '@/hooks/useWatchTogether'

// The watch page's Watch Together control. Inactive: one tap starts a synced session and
// invites the household (live toast on their open tabs). Active: shows the room, with
// invite/leave/end in a menu. Styled to sit in the watch page's vertical icon rail.
export function WatchTogetherPill({ wt, className }: { wt: ReturnType<typeof useWatchTogether>; className?: string }) {
  if (!wt.sessionId) {
    return (
      // design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop
      <Button size="icon" onClick={() => void wt.start()}
        title="Watch together: invite your household to watch this with you, in sync"
        aria-label="Watch together"
        className={cn('size-10 rounded-full bg-white/10 text-foreground/85 shadow-none hover:bg-white/15', className)}>
        <Users className="size-4" />
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" title="Watching together" aria-label="Watching together"
          className={cn('relative size-10 rounded-full bg-brand text-brand-foreground shadow-none hover:bg-brand/90', className)}>
          <Users className="size-4" />
          <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-background text-[9px] font-bold text-foreground">
            {wt.memberCount}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Watching together</DropdownMenuLabel>
        {wt.members.map((m) => (
          <DropdownMenuItem key={m.id} disabled className="opacity-80">
            <span className="truncate">{m.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void wt.invite()}>
          <RefreshCw className="size-4" /> Invite again
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => wt.leave()}>
          <LogOut className="size-4" /> Leave
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void wt.end()}>
          <Square className="size-4" /> End for everyone
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
