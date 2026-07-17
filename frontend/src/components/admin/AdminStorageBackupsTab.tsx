import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, CloudDownload, DatabaseBackup, Play, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BackupConfig {
  enabled: boolean
  time: string
  retainCount: number
  storageLocationId: string | null
  includeFiles: boolean
}

interface BackupRow {
  id: string
  kind: 'manual' | 'scheduled' | 'pre-update'
  status: 'running' | 'complete' | 'failed'
  destinationPath: string
  dbFileName: string | null
  dbSizeBytes: number | null
  filesSynced: number | null
  filesBytes: number | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

interface StorageLocation {
  id: string
  name: string
  path: string
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/admin/backups${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  try {
    return (await r.json()) as T
  } catch {
    throw new Error(`Unexpected response (${r.status}) from /api/admin/backups${path}`)
  }
}

function formatBytes(n: number | null): string {
  if (n == null) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`
  return `${n} B`
}

const KIND_LABELS: Record<BackupRow['kind'], string> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  'pre-update': 'Pre-update',
}

// ── Main component ────────────────────────────────────────────────────────────

export function AdminStorageBackupsTab() {
  const [config, setConfig] = useState<BackupConfig | null>(null)
  const [root, setRoot] = useState('')
  const [rows, setRows] = useState<BackupRow[]>([])
  const [running, setRunning] = useState(false)
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BackupRow | null>(null)
  const [restoreStaged, setRestoreStaged] = useState(false)
  const [restoringFiles, setRestoringFiles] = useState(false)
  const pollRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const [res, locRes] = await Promise.all([
        api<{ config: BackupConfig; root: string; running: boolean; backups: BackupRow[] }>(''),
        fetch('/api/admin/storage-locations', { credentials: 'include' })
          .then((r) => r.json() as Promise<{ locations: StorageLocation[] }>)
          .catch(() => ({ locations: [] as StorageLocation[] })),
      ])
      setConfig(res.config)
      setRoot(res.root)
      setRows(res.backups ?? [])
      setRunning(res.running)
      setLocations(locRes.locations ?? [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load backups')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // While a backup runs, poll so the row flips to complete without a manual refresh.
  useEffect(() => {
    if (!running) return
    pollRef.current = window.setInterval(() => { void load() }, 3000)
    return () => { if (pollRef.current) window.clearInterval(pollRef.current) }
  }, [running, load])

  async function saveConfig(patch: Partial<BackupConfig>) {
    if (!config) return
    const next = { ...config, ...patch }
    setConfig(next)
    setSaving(true)
    try {
      const res = await api<{ ok: boolean; error?: string; root?: string }>('/config', {
        method: 'PUT',
        body: JSON.stringify(next),
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save backup settings')
        await load()
        return
      }
      if (res.root) setRoot(res.root)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save backup settings')
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function runNow() {
    const res = await api<{ ok: boolean; error?: string }>('/run', { method: 'POST' })
    if (!res.ok) {
      toast.error(res.error ?? 'Could not start the backup')
      return
    }
    setRunning(true)
    await load()
  }

  async function handleRestore() {
    if (!restoreTarget) return
    const res = await api<{ ok: boolean; error?: string }>('/restore', {
      method: 'POST',
      body: JSON.stringify({ backupId: restoreTarget.id }),
    })
    setRestoreTarget(null)
    if (!res.ok) {
      toast.error(res.error ?? 'Could not stage the restore')
      return
    }
    setRestoreStaged(true)
  }

  async function restartNow() {
    toast.success('Restarting the server to finish the restore')
    await fetch('/api/admin/server/restart', { method: 'POST', credentials: 'include' }).catch(() => {})
  }

  async function handleRestoreFiles() {
    setRestoringFiles(true)
    try {
      const res = await api<{ ok: boolean; copied: number; error?: string }>('/restore-files', { method: 'POST' })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not restore files')
        return
      }
      toast.success(res.copied === 0
        ? 'No files were missing; nothing to restore'
        : `Restored ${res.copied} missing file${res.copied === 1 ? '' : 's'}`)
    } finally {
      setRestoringFiles(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const res = await api<{ ok: boolean; error?: string }>(`/${deleteTarget.id}`, { method: 'DELETE' })
    setDeleteTarget(null)
    if (!res.ok) {
      toast.error(res.error ?? 'Could not delete the backup')
      return
    }
    await load()
  }

  if (loading) return <div className="flex justify-center py-12"><Spinner /></div>
  if (loadError || !config) {
    return <div className="text-sm text-destructive py-6">{loadError ?? 'Could not load backups'}</div>
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* ── Settings ── */}
      <section className="rounded-card border border-border bg-card p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-medium flex items-center gap-2">
              <DatabaseBackup className="size-4 text-brand" /> Nightly backup
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Snapshots the database every day and keeps a mirror of the family's files.
              Model downloads, maps, and other re-downloadable content are not included.
            </p>
          </div>
          <Switch
            checked={config.enabled}
            onCheckedChange={(v) => void saveConfig({ enabled: v })}
            aria-label="Enable nightly backups"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="text-muted-foreground">Run at</span>
            <Input
              type="time"
              value={config.time}
              onChange={(e) => void saveConfig({ time: e.target.value })}
              className="w-32"
            />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="text-muted-foreground">Snapshots to keep</span>
            <Input
              type="number"
              min={1}
              max={365}
              value={config.retainCount}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                if (!Number.isNaN(n)) void saveConfig({ retainCount: n })
              }}
              className="w-24"
            />
          </label>
          <label className="space-y-1.5 text-sm sm:col-span-2">
            <span className="text-muted-foreground">Destination</span>
            <select
              value={config.storageLocationId ?? ''}
              onChange={(e) => void saveConfig({ storageLocationId: e.target.value || null })}
              className="w-full h-9 rounded-control border border-input bg-transparent px-3 text-sm"
            >
              <option value="">Server data folder (default)</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.name} ({loc.path})</option>
              ))}
            </select>
            <span className="block text-xs text-muted-foreground">
              Backups are written to <code className="text-foreground/80">{root}</code>.
              Add a NAS or external drive under Storage, Locations to keep backups off this machine.
            </span>
          </label>
        </div>

        <div className="flex items-center justify-between gap-4 pt-1 border-t border-border/60">
          <div className="text-sm pt-3">
            <div className="font-medium">Include the family's files</div>
            <p className="text-muted-foreground text-xs mt-0.5">
              Generated images, voice memos, home inventory photos, and trained wake words.
              Only changed files are copied on each run.
            </p>
          </div>
          <Switch
            checked={config.includeFiles}
            onCheckedChange={(v) => void saveConfig({ includeFiles: v })}
            aria-label="Include user files in backups"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button size="sm" onClick={() => void runNow()} disabled={running}>
            {running ? <Spinner className="size-4" /> : <Play className="size-4" />}
            {running ? 'Backing up' : 'Back up now'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void handleRestoreFiles()} disabled={restoringFiles}>
            <CloudDownload className="size-4" />
            {restoringFiles ? 'Restoring files' : 'Restore missing files'}
          </Button>
          {saving && <span className="text-xs text-muted-foreground">Saving</span>}
        </div>
      </section>

      {/* ── Restore staged banner ── */}
      {restoreStaged && (
        <section className="rounded-card border border-brand/50 bg-brand/5 p-4 flex items-start justify-between gap-4">
          <div className="text-sm">
            <div className="font-medium">Restore is staged</div>
            <p className="text-muted-foreground mt-0.5">
              The snapshot will replace the current database on the next restart.
              The replaced database is kept on disk in case you need to go back.
            </p>
          </div>
          <Button size="sm" onClick={() => void restartNow()}>
            <RotateCcw className="size-4" /> Restart now
          </Button>
        </section>
      )}

      {/* ── Snapshot list ── */}
      <section className="space-y-2">
        <h3 className="font-medium flex items-center gap-2">
          <Archive className="size-4 text-muted-foreground" /> Snapshots
        </h3>
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No backups yet. Turn on nightly backups or run one now.
          </p>
        )}
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded-card border border-border bg-card px-4 py-3 flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">
                    {new Date(row.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                  <span className="text-xs rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                    {KIND_LABELS[row.kind]}
                  </span>
                  {row.status === 'running' && <Spinner className="size-3.5" />}
                  {row.status === 'failed' && <span className="text-xs text-destructive">Failed</span>}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 truncate">
                  {row.status === 'failed'
                    ? row.error
                    : [
                        row.dbSizeBytes != null ? `Database ${formatBytes(row.dbSizeBytes)}` : null,
                        row.filesSynced != null ? `${row.filesSynced} file${row.filesSynced === 1 ? '' : 's'} synced` : null,
                      ].filter(Boolean).join(', ') || 'Running'}
                </div>
              </div>
              <div className={cn('flex items-center gap-1', row.status !== 'complete' && 'opacity-40 pointer-events-none')}>
                <Button size="sm" variant="outline" onClick={() => setRestoreTarget(row)}>
                  <RotateCcw className="size-3.5" /> Restore
                </Button>
                <Button size="icon" variant="ghost" aria-label="Delete backup" onClick={() => setDeleteTarget(row)}>
                  <Trash2 className="size-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={restoreTarget != null}
        onOpenChange={(open) => { if (!open) setRestoreTarget(null) }}
        title="Restore this snapshot?"
        description={restoreTarget
          ? `The database will be rolled back to ${new Date(restoreTarget.startedAt).toLocaleString()}. Anything saved since then (notes, chats, settings) will disappear from the app. The restore happens on the next restart, and the replaced database is kept on disk.`
          : ''}
        confirmLabel="Stage restore"
        onConfirm={() => void handleRestore()}
      />
      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="Delete this backup?"
        description="The snapshot file is removed from the backup destination. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}
