// Admin → Music: music source configuration. Adding a local folder validates, saves, and
// queues the first scan in one action (no separate enable switch). Plex music sections and
// content protections join this tab in later phases.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FolderOpen, LibraryBig, Music, RefreshCw, Trash2, Upload, AlertTriangle, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

interface MusicFolder {
  id: string
  path: string
  name: string
  kind: 'admin' | 'uploads'
  enabled: boolean
  trackCount: number
  lastScanAt: string | null
  lastScanStatus: 'idle' | 'scanning' | 'ok' | 'failed'
  lastScanError: string | null
  scanJob: { status: string; progress: { completed?: number; total?: number; status?: string } | null } | null
}

interface PlexMusicState {
  configured: boolean
  sections: Array<{ key: string; title: string; selected: boolean; trackCount: number }>
  lastSyncAt: number | null
  syncing: boolean
  mirrorTracks: number
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/admin/music${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  try {
    return (await r.json()) as T
  } catch {
    throw new Error(`Unexpected response (${r.status}) from /api/admin/music${path}`)
  }
}

function scanStatusLabel(f: MusicFolder): { text: string; tone: 'muted' | 'success' | 'destructive' } {
  if (f.lastScanStatus === 'scanning') {
    const p = f.scanJob?.progress
    const detail = p?.total ? ` · ${p.completed ?? 0}/${p.total} files` : ''
    return { text: `Scanning${detail}…`, tone: 'muted' }
  }
  if (f.lastScanStatus === 'failed') return { text: f.lastScanError ?? 'Scan failed', tone: 'destructive' }
  if (f.lastScanStatus === 'ok') return { text: `${f.trackCount.toLocaleString()} tracks`, tone: 'success' }
  return { text: 'Not scanned yet', tone: 'muted' }
}

export function AdminMusicTab() {
  const [folders, setFolders] = useState<MusicFolder[]>([])
  const [plex, setPlex] = useState<PlexMusicState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [newPath, setNewPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MusicFolder | null>(null)
  const [sectionSaving, setSectionSaving] = useState(false)
  const [preferLibrary, setPreferLibrary] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function togglePreferLibrary(on: boolean) {
    setPreferLibrary(on)  // optimistic
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ preferLibrary: on }) })
      toast.success(on ? 'Your library plays first when you own the song' : 'Streaming plays even for songs you own')
    } catch {
      setPreferLibrary(!on)
      toast.error('Could not save the preference')
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await api<{ local: { folders: MusicFolder[] }; plex: PlexMusicState; settings?: { preferLibrary: boolean } }>('/sources')
      setFolders(res.local?.folders ?? [])
      setPlex(res.plex ?? null)
      setPreferLibrary(res.settings?.preferLibrary ?? true)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load music sources')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Poll while any scan/sync runs so counts/progress stay live without a manual refresh.
  const anyScanning = folders.some((f) => f.lastScanStatus === 'scanning') || !!plex?.syncing
  useEffect(() => {
    if (!anyScanning) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }; return }
    pollRef.current = setInterval(load, 4000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [anyScanning, load])

  async function toggleSection(key: string, selected: boolean) {
    if (!plex) return
    const next = plex.sections.map((s) => (s.key === key ? { ...s, selected } : s))
    setPlex({ ...plex, sections: next })  // optimistic
    setSectionSaving(true)
    try {
      const res = await api<{ ok?: boolean; error?: string }>('/plex-sections', {
        method: 'PUT', body: JSON.stringify({ keys: next.filter((s) => s.selected).map((s) => s.key) }),
      })
      if (res.error) { toast.error(res.error); await load(); return }
      toast.success(selected ? 'Section added - syncing now' : 'Section removed - mirror updates on this sync')
      await load()
    } catch {
      toast.error('Could not update Plex sections')
      await load()
    } finally {
      setSectionSaving(false)
    }
  }

  async function handlePlexSync() {
    try {
      const res = await api<{ ok?: boolean; error?: string }>('/plex-sync', { method: 'POST' })
      if (res.error) { toast.error(res.error); return }
      toast.success('Syncing your Plex music library')
      await load()
    } catch {
      toast.error('Could not start the sync')
    }
  }

  async function handleAdd() {
    const path = newPath.trim()
    if (!path) return
    setAdding(true)
    setAddError(null)
    try {
      const res = await api<{ folder?: MusicFolder; error?: string }>('/local-folders', {
        method: 'POST', body: JSON.stringify({ path }),
      })
      if (res.error) { setAddError(res.error); return }
      setNewPath('')
      toast.success('Folder added - scanning now')
      await load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add folder')
    } finally {
      setAdding(false)
    }
  }

  async function handleScan(folder: MusicFolder) {
    try {
      await api(`/local-folders/${folder.id}/scan`, { method: 'POST' })
      toast.success(`Rescanning ${folder.name}`)
      await load()
    } catch {
      toast.error('Could not start the scan')
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      const res = await api<{ ok?: boolean; error?: string }>(`/local-folders/${deleteTarget.id}`, { method: 'DELETE' })
      if (res.error) { toast.error(res.error); return }
      toast.success('Folder removed from the library (files untouched)')
      await load()
    } catch {
      toast.error('Could not remove the folder')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6 p-5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-control bg-muted p-2"><Music className="size-5 text-muted-foreground" /></div>
        <div>
          <h2 className="text-title">Music Sources</h2>
          <p className="text-sm text-muted-foreground">
            Point the Music app at folders of audio files on this server. Everything found becomes part of the
            family's shared Collection and plays at its original quality.
          </p>
        </div>
      </div>

      {/* Add folder */}
      <div id="sources" className="rounded-card border border-border bg-card p-4">
        <div className="mb-2 text-sm font-medium">Add a music folder</div>
        <p className="mb-3 text-xs text-muted-foreground">
          Absolute path on the server (a NAS mount works - read access is enough). The folder is scanned
          immediately and rescanned daily.
        </p>
        <div className="flex gap-2">
          <Input
            value={newPath}
            onChange={(e) => { setNewPath(e.target.value); setAddError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            placeholder="/mnt/media/Music"
            className="font-mono text-sm"
          />
          <Button onClick={handleAdd} disabled={adding || !newPath.trim()}>
            {adding ? <Spinner className="size-4" /> : <Plus className="size-4" />} Add
          </Button>
        </div>
        {addError && (
          <div className="mt-2 flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0" /> {addError}
          </div>
        )}
      </div>

      {/* Folder list */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" /> Loading…</div>
      ) : loadError ? (
        <div className="flex items-center gap-2 text-sm text-destructive"><AlertTriangle className="size-4" /> {loadError}</div>
      ) : folders.length === 0 ? (
        <p className="text-sm text-muted-foreground">No folders yet - add one above to build the Collection.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {folders.map((f) => {
            const status = scanStatusLabel(f)
            return (
              <div key={f.id} className="flex items-center gap-3 rounded-card border border-border bg-card p-3">
                <div className="shrink-0 rounded-control bg-muted p-2">
                  {f.kind === 'uploads' ? <Upload className="size-4 text-muted-foreground" /> : <FolderOpen className="size-4 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{f.name}</span>
                    {f.kind === 'uploads' && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Uploads</span>
                    )}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{f.path}</div>
                  <div className={cn('mt-0.5 text-xs',
                    status.tone === 'success' && 'text-success',
                    status.tone === 'destructive' && 'text-destructive',
                    status.tone === 'muted' && 'text-muted-foreground',
                  )}>
                    {f.lastScanStatus === 'scanning' && <Spinner className="mr-1 inline-block size-3 align-[-2px]" />}
                    {status.text}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleScan(f)} disabled={f.lastScanStatus === 'scanning'} title="Rescan">
                  <RefreshCw className="size-4" />
                </Button>
                {f.kind !== 'uploads' && (
                  <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(f)} title="Remove from library">
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Plex Music */}
      {!loading && !loadError && (
        <div className="rounded-card border border-border bg-card p-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Plex Music</div>
            {plex?.configured && (
              <Button variant="ghost" size="sm" onClick={handlePlexSync} disabled={plex.syncing || sectionSaving} title="Sync now">
                {plex.syncing ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
                {plex.syncing ? 'Syncing…' : 'Sync now'}
              </Button>
            )}
          </div>
          {!plex?.configured ? (
            <p className="text-xs text-muted-foreground">
              Connect a Plex server under{' '}
              <Link to="/admin/integrations/plex" className="text-brand underline-offset-2 hover:underline">Integrations → Plex</Link>
              {' '}to bring its music libraries into the Collection.
            </p>
          ) : plex.sections.length === 0 ? (
            <p className="text-xs text-muted-foreground">Your Plex server has no music libraries.</p>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                Pick which Plex music libraries join the family's Collection. Tracks stream from Plex at original
                quality and stay in sync automatically.
              </p>
              <div className="flex flex-col gap-1.5">
                {plex.sections.map((s) => (
                  <label key={s.key} className="flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 transition hover:bg-accent/40">
                    <Switch size="sm" checked={s.selected} disabled={sectionSaving} onCheckedChange={(v) => toggleSection(s.key, v === true)} />
                    <LibraryBig className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{s.title}</span>
                    {s.selected && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {s.trackCount > 0 ? `${s.trackCount.toLocaleString()} tracks` : plex.syncing ? 'syncing…' : 'pending sync'}
                      </span>
                    )}
                  </label>
                ))}
              </div>
              {plex.lastSyncAt && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Last synced {new Date(plex.lastSyncAt).toLocaleString()} · {plex.mirrorTracks.toLocaleString()} tracks mirrored
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Resolution preference */}
      {!loading && !loadError && (
        <div className="rounded-card border border-border bg-card p-4">
          <label className="flex cursor-pointer items-center gap-2.5">
            <Switch size="sm" checked={preferLibrary} onCheckedChange={(v) => togglePreferLibrary(v === true)} />
            <div className="min-w-0">
              <div className="text-sm font-medium">Prefer my library</div>
              <p className="text-xs text-muted-foreground">
                When the family owns a song (local file or Plex), stations, search, and playlists play that copy
                at its original quality instead of streaming it.
              </p>
            </div>
          </label>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="Remove this folder from the library?"
        description={`"${deleteTarget?.path}" and its files stay on disk - only the app's index of ${deleteTarget?.trackCount.toLocaleString() ?? 0} tracks is removed. Playlists fall back to online playback for these songs.`}
        confirmLabel="Remove folder"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  )
}
