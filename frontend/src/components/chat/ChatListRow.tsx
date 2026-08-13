import { useState } from 'react'
import type { ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/lib/relativeTime'

/** A full-width conversation row used by the project landing page and the Chats browse page. */
export function ChatListRow({
  title, projectName, updatedAt, onSelect, onDelete,
  selectMode = false, selected = false, onToggleSelect, actions,
}: {
  title: string
  projectName?: string | null
  updatedAt: Date
  onSelect: () => void
  onDelete?: () => void
  selectMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  /** Extra hover actions rendered to the left of delete (archive, export, restore…). */
  actions?: ReactNode
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className={cn(
        'group relative flex items-center border-b border-border/15 transition-colors last:border-0 hover:bg-foreground/[0.03]',
        selectMode && selected && 'bg-brand/5',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {selectMode && (
        /* design-ok(raw-input-element): native checkbox for bulk-select, no ui/ Checkbox primitive (same pattern as AdminUsersTab) */
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect?.()}
          aria-label={`Select "${title}"`}
          className="ml-1 size-4 shrink-0 rounded border-border accent-brand"
        />
      )}
      <button
        onClick={selectMode ? onToggleSelect : onSelect}
        className="flex flex-1 min-w-0 items-center gap-3 py-3 pl-1 pr-2 text-left"
      >
        <span className="flex-1 min-w-0 truncate text-sm text-foreground">{title}</span>
        {projectName && (
          <span className="hidden shrink-0 truncate text-xs text-muted-foreground/60 sm:inline">
            {projectName}
          </span>
        )}
        <span className={cn(
          'shrink-0 text-xs text-muted-foreground/50 transition-opacity',
          hovered && !selectMode ? 'opacity-0' : 'opacity-100',
        )}>
          {formatRelativeTime(updatedAt)}
        </span>
      </button>

      {hovered && !selectMode && (actions || onDelete) && (
        <div className="absolute right-1 flex shrink-0 items-center gap-0.5 rounded-control bg-background/80 backdrop-blur-sm">
          {actions}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              title="Delete conversation"
              aria-label="Delete conversation"
              className="shrink-0 rounded-control text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
