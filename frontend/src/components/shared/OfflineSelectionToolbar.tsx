// Shared "Clear All / Clear Selected" toolbar for an app's Offline (downloaded
// content) view, used identically by YouTube, Music, Podcasts, and Books so the
// bulk-delete UX matches everywhere instead of four slightly different ones.
// Purely presentational: the caller owns selection state and the actual delete
// calls (each app's downloaded-item shape and delete API differ), this just
// renders the row of controls and the two confirmation dialogs.

import { useState } from 'react'
import { CheckSquare, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Spinner } from '@/components/ui/spinner'

export interface OfflineSelectionToolbarProps {
  totalCount: number
  selectedCount: number
  allSelected: boolean
  busy?: boolean
  onToggleSelectAll: () => void
  onClearSelected: () => void | Promise<void>
  onClearAll: () => void | Promise<void>
  itemLabel?: string
}

export function OfflineSelectionToolbar({
  totalCount, selectedCount, allSelected, busy, onToggleSelectAll, onClearSelected, onClearAll, itemLabel = 'item',
}: OfflineSelectionToolbarProps) {
  const [confirmSelected, setConfirmSelected] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)

  if (totalCount === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-card border border-border/50 bg-card/50 px-3 py-2">
      <button
        type="button"
        onClick={onToggleSelectAll}
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {allSelected ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
        {allSelected ? 'Deselect all' : 'Select all'}
      </button>

      <span className="text-xs text-muted-foreground">{selectedCount > 0 ? `${selectedCount} selected` : `${totalCount} ${itemLabel}${totalCount === 1 ? '' : 's'}`}</span>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={selectedCount === 0 || busy} onClick={() => setConfirmSelected(true)}>
          {busy ? <Spinner size="sm" className="mr-1.5" /> : <Trash2 className="mr-1.5 size-3.5" />}Clear Selected
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmAll(true)}>
          Clear All
        </Button>
      </div>

      <ConfirmDialog
        open={confirmSelected}
        onOpenChange={setConfirmSelected}
        title={`Remove ${selectedCount} ${itemLabel}${selectedCount === 1 ? '' : 's'} from offline?`}
        description="This removes the local copy. You can download it again later."
        confirmLabel="Remove"
        destructive
        onConfirm={() => void onClearSelected()}
      />
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={`Remove all ${totalCount} ${itemLabel}${totalCount === 1 ? '' : 's'} from offline?`}
        description="This removes every local copy shown here. You can download them again later."
        confirmLabel="Remove All"
        destructive
        onConfirm={() => void onClearAll()}
      />
    </div>
  )
}
