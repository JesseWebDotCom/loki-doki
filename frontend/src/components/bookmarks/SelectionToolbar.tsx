// Floating toolbar over a text selection in the reader: color dots + Highlight /
// Highlight-with-note. Fixed-positioned at the selection rect from useHighlightAnchoring.

import { useState } from 'react'
import { Highlighter, MessageSquarePlus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { HighlightColor } from '@/lib/bookmarks/api'
import { HIGHLIGHT_MARK_CLASS, type PendingSelection } from './useHighlightAnchoring'

const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple']

// Swatch palette data: these five hues ARE the highlight-color product feature
// (the user picks between them), not decorative accents - keep the raw hues.
const DOT_CLASS: Record<HighlightColor, string> = {
  // design-ok(raw-palette-semantic): user-selectable highlight-color swatch data
  yellow: 'bg-yellow-400',
  // design-ok(raw-palette-semantic): user-selectable highlight-color swatch data
  green: 'bg-emerald-400',
  // design-ok(raw-palette-semantic): user-selectable highlight-color swatch data
  blue: 'bg-sky-400',
  // design-ok(raw-palette-semantic): user-selectable highlight-color swatch data
  pink: 'bg-pink-400',
  // design-ok(banned-palette): user-selectable highlight-color swatch data
  purple: 'bg-violet-400',
}

export function SelectionToolbar({ selection, onHighlight, onCancel }: {
  selection: PendingSelection
  onHighlight: (color: HighlightColor, note?: string) => void
  onCancel: () => void
}) {
  const [color, setColor] = useState<HighlightColor>('yellow')
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')

  const top = Math.max(8, selection.rect.top - (noteOpen ? 148 : 48))
  const left = Math.min(Math.max(8, selection.rect.left + selection.rect.width / 2 - 130), window.innerWidth - 268)

  return (
    <div
      className="fixed z-50 w-[260px] rounded-sheet border border-border/70 bg-popover p-2 shadow-lg"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`${c} highlight`}
            onClick={() => setColor(c)}
            className={cn('size-5 rounded-full transition-transform', DOT_CLASS[c], color === c && 'scale-110 ring-2 ring-foreground/50')}
          />
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setNoteOpen((v) => !v)}>
            <MessageSquarePlus className="size-3.5" /> Note
          </Button>
          <Button size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => onHighlight(color, note.trim() || undefined)}>
            <Highlighter className="size-3.5" /> Highlight
          </Button>
        </div>
      </div>
      {noteOpen && (
        <div className="mt-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note…"
            className="h-20 resize-none text-sm"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onHighlight(color, note.trim() || undefined)
              if (e.key === 'Escape') onCancel()
            }}
          />
          <div className={cn('mt-1 h-1 w-full rounded-full opacity-60', HIGHLIGHT_MARK_CLASS[color])} />
        </div>
      )}
    </div>
  )
}
