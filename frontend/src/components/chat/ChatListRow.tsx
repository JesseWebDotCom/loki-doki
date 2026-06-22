import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatRelativeTime } from '@/lib/relativeTime'

/** A full-width conversation row used by the project landing page and the Chats browse page. */
export function ChatListRow({
  title, projectName, updatedAt, onSelect, onDelete,
}: {
  title: string
  projectName?: string | null
  updatedAt: Date
  onSelect: () => void
  onDelete: () => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="group relative flex items-center border-b border-border/15 last:border-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onSelect}
        className="flex flex-1 min-w-0 items-center gap-3 py-3 pl-1 pr-2 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        <span className="flex-1 min-w-0 truncate text-sm text-foreground">{title}</span>
        {projectName && (
          <span className="hidden shrink-0 truncate text-xs text-muted-foreground/60 sm:inline">
            {projectName}
          </span>
        )}
        <span className={cn(
          'shrink-0 text-xs text-muted-foreground/50 transition-opacity',
          hovered ? 'opacity-0' : 'opacity-100',
        )}>
          {formatRelativeTime(updatedAt)}
        </span>
      </button>

      {hovered && (
        <button
          onClick={onDelete}
          title="Delete conversation"
          className="absolute right-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}
