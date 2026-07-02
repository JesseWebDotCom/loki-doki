// Highlights & notes side panel for the bookmarks reader: list, click-to-scroll,
// note editing, color change, delete, and orphan badges (quote no longer found in the
// current archive — the text changed under it).

import { useState } from 'react'
import { Highlighter, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import type { Highlight, HighlightColor } from '@/lib/bookmarks/api'

const EDGE_CLASS: Record<HighlightColor, string> = {
  yellow: 'border-l-yellow-400',
  green: 'border-l-emerald-400',
  blue: 'border-l-sky-400',
  pink: 'border-l-pink-400',
  purple: 'border-l-violet-400',
}

const DOT_CLASS: Record<HighlightColor, string> = {
  yellow: 'bg-yellow-400',
  green: 'bg-emerald-400',
  blue: 'bg-sky-400',
  pink: 'bg-pink-400',
  purple: 'bg-violet-400',
}

const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple']

export function HighlightsPanel({ highlights, orphanedIds, onJump, onUpdate, onDelete }: {
  highlights: Highlight[]
  orphanedIds: Set<string>
  onJump: (id: string) => void
  onUpdate: (id: string, patch: { color?: HighlightColor; note?: string | null }) => void
  onDelete: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  if (!highlights.length) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-muted-foreground">
        <Highlighter className="size-6" />
        <p className="text-sm">No highlights yet</p>
        <p className="text-xs">Select any text in the article to highlight it or attach a note.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2 p-3">
      {highlights.map((h) => {
        const orphaned = orphanedIds.has(h.id)
        const editing = editingId === h.id
        return (
          <div
            key={h.id}
            className={cn('rounded-lg border border-border/50 border-l-2 bg-card/60 p-2.5', EDGE_CLASS[h.color] ?? 'border-l-yellow-400')}
          >
            {h.quote && (
              <button
                type="button"
                onClick={() => !orphaned && onJump(h.id)}
                className={cn('block w-full text-left text-sm leading-snug', orphaned ? 'cursor-default text-muted-foreground' : 'hover:underline')}
              >
                “{h.quote.length > 180 ? `${h.quote.slice(0, 177)}…` : h.quote}”
              </button>
            )}
            {orphaned && (
              <span className="mt-1 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                outdated — the article text changed
              </span>
            )}

            {editing ? (
              <div className="mt-2">
                <Textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="Note…"
                  className="h-16 resize-none text-sm"
                  autoFocus
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`${c} highlight`}
                      onClick={() => onUpdate(h.id, { color: c })}
                      className={cn('size-4 rounded-full', DOT_CLASS[c], h.color === c && 'ring-2 ring-foreground/50')}
                    />
                  ))}
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                    <Button size="sm" className="h-6 px-2 text-xs" onClick={() => { onUpdate(h.id, { note: noteDraft.trim() || null }); setEditingId(null) }}>Save</Button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {h.note && <p className="mt-1.5 text-xs text-muted-foreground">{h.note}</p>}
                <div className="mt-1.5 flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => { setEditingId(h.id); setNoteDraft(h.note ?? '') }}>
                    {h.note ? 'Edit note' : 'Add note'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-destructive hover:text-destructive" onClick={() => setConfirmDelete(h.id)}>
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </>
            )}
          </div>
        )
      })}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => { if (!open) setConfirmDelete(null) }}
        title="Delete this highlight?"
        description="The highlight and its note are removed permanently."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (confirmDelete) onDelete(confirmDelete) }}
      />
    </div>
  )
}
