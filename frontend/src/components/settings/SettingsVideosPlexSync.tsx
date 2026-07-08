// The current user's exported Plex video libraries + their sync policies (all /
// most-recent-N / delete-after-watching). Provisioning itself is admin-side (Admin →
// Plex or the setup wizard); this section is where a user tunes their OWN libraries.
// Every export source is always listed - a source with no provisioned library renders
// disabled, with a note saying exactly which admin step is missing (storage location +
// Plex path mapping vs. library provisioning), instead of silently not appearing.

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { LibraryPolicyEditor } from '@/components/media/LibraryPolicyEditor'
import {
  getMyLibrarySections, patchMyLibraryPolicy, PLEX_EXPORT_SOURCES,
  type MyLibrarySections,
} from '@/lib/plex/api'

export function SettingsVideosPlexSync() {
  const [data, setData] = useState<MyLibrarySections | null>(null)

  const load = useCallback(() => {
    getMyLibrarySections().then(setData).catch(() => setData({ sections: [], storageReady: {} }))
  }, [])

  useEffect(() => { load() }, [load])

  if (data == null) return <Spinner size="sm" className="text-muted-foreground" />

  const bySource = new Map(data.sections.map(s => [s.contentType, s]))

  return (
    <div className="space-y-2">
      <p className="text-overline text-muted-foreground">Plex libraries</p>
      <p className="text-[11px] text-muted-foreground/70 -mt-1">
        Your saved videos export into private Plex libraries only you can see. Limit each
        library to the most recent videos per creator, or automatically delete a download
        once you've fully watched it - just like Plex's own downloads.
      </p>
      <div className="space-y-2 pt-1">
        {PLEX_EXPORT_SOURCES.map(({ key, label }) => {
          const section = bySource.get(key)
          if (!section) {
            const storageReady = data.storageReady[key] === true
            return (
              <div key={key} className="space-y-1 rounded-card border border-border/40 bg-background/30 px-4 py-3 opacity-70">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold text-muted-foreground">{label}</p>
                  <span className="text-xs text-muted-foreground">Not set up</span>
                </div>
                <p className="text-[11px] text-muted-foreground/70">
                  {storageReady
                    ? `Storage is ready - ask an admin to provision your ${label} library (Admin → Plex).`
                    : `Storage not set up - an admin needs to assign a storage location with a Plex path mapping for ${label} (Admin → Storage Locations).`}
                </p>
              </div>
            )
          }
          return (
            <div key={key} className="space-y-1.5 rounded-card border border-border/50 bg-background/50 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold">{label}</p>
                {section.status === 'ready' ? (
                  <span className="inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="size-3.5" /> Ready</span>
                ) : section.status === 'error' ? (
                  <span className="inline-flex items-center gap-1 text-xs text-destructive"><AlertTriangle className="size-3.5" /> Error</span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner size="sm" /> Provisioning…</span>
                )}
              </div>
              {section.status === 'ready' && (
                <LibraryPolicyEditor
                  section={section}
                  onPatch={patch => patchMyLibraryPolicy(section.contentType, patch)}
                  onSaved={load}
                />
              )}
              {section.status === 'error' && section.error && (
                <p className="text-xs text-destructive">{section.error}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
