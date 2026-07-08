// Per-library sync policy controls (all / most-recent-N / remove-watched) - the same
// options Plex's own download feature offers. Used by AdminPlexTab (per user) and the
// Videos settings "Plex sync" section (own libraries).

import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Switch } from '@/components/ui/switch'
import { type PlexLibrarySection, type LibraryPolicyPatch } from '@/lib/plex/api'

const RECENT_CHOICES = [5, 10, 25, 50, 100]
const DEFAULT_RECENT = 25

interface LibraryPolicyEditorProps {
  section: PlexLibrarySection
  /** Applies the patch (admin vs own-user endpoint differs); resolves to an error or null. */
  onPatch: (patch: LibraryPolicyPatch) => Promise<string | null>
  onSaved?: () => void
}

export function LibraryPolicyEditor({ section, onPatch, onSaved }: LibraryPolicyEditorProps) {
  const [busy, setBusy] = useState(false)
  const isMine = section.contentType === 'mine'

  const apply = async (patch: LibraryPolicyPatch) => {
    setBusy(true)
    try {
      const err = await onPatch(patch)
      if (err) toast.error(err)
      else onSaved?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <label className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Keep in Plex</span>
        <select
          value={section.syncMode === 'recent' ? String(section.syncRecentCount ?? DEFAULT_RECENT) : 'all'}
          disabled={busy}
          onChange={e => {
            const v = e.target.value
            if (v === 'all') void apply({ syncMode: 'all' })
            else void apply({ syncMode: 'recent', syncRecentCount: Number(v) })
          }}
          className="rounded-control border border-border bg-background px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-brand"
        >
          <option value="all">All videos</option>
          {RECENT_CHOICES.map(n => (
            <option key={n} value={n}>{`Most recent ${n} per creator`}</option>
          ))}
        </select>
      </label>
      {!isMine && (
        <label className="flex items-center gap-1.5">
          <Switch
            checked={section.removeWatched}
            disabled={busy}
            onCheckedChange={v => void apply({ removeWatched: v })}
          />
          <span className="text-muted-foreground">Delete after watching</span>
        </label>
      )}
    </div>
  )
}
