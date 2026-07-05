import { useEffect, useState } from 'react'
import { HardDrive, CheckCircle2, XCircle, Trash2, Plus, Link2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'

// ── Types ─────────────────────────────────────────────────────────────────────

interface StorageLocation {
  id: string
  name: string
  path: string
  plexPath: string | null
}

interface AccessCheckResult {
  ok: boolean
  checks: { read: boolean; write: boolean; rename: boolean; delete: boolean }
  error: string | null
  freeFormatted: string | null
}

interface ContentTypeAssignment {
  contentType: string
  storageLocationId: string | null
}

// Phase 0 ships YouTube only, extend this list as Podcasts/Music/Audiobooks reuse
// the same generic Storage Locations infra.
const CONTENT_TYPES = [{ key: 'youtube', label: 'YouTube' }]

// ── Helpers ───────────────────────────────────────────────────────────────────

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok
        ? <CheckCircle2 className="size-4 text-success shrink-0" />
        : <XCircle className="size-4 text-destructive shrink-0" />}
      <span className={ok ? 'text-foreground' : 'text-destructive'}>{label}</span>
    </div>
  )
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/admin/storage-locations${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  return r.json() as Promise<T>
}

// ── Main component ────────────────────────────────────────────────────────────

export function AdminStorageLocationsTab() {
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [assignments, setAssignments] = useState<ContentTypeAssignment[]>([])
  const [loading, setLoading] = useState(true)

  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<AccessCheckResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [plexPathDrafts, setPlexPathDrafts] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<StorageLocation | null>(null)

  async function load() {
    const [locRes, ctRes] = await Promise.all([
      api<{ locations: StorageLocation[] }>('/'),
      api<{ assignments: ContentTypeAssignment[] }>('/content-types'),
    ])
    setLocations(locRes.locations ?? [])
    setAssignments(ctRes.assignments ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleValidate() {
    if (!path.trim()) return
    setValidating(true)
    setValidation(null)
    setFormError(null)
    const result = await api<AccessCheckResult>('/validate', { method: 'POST', body: JSON.stringify({ path: path.trim() }) })
    setValidation(result)
    setValidating(false)
  }

  async function handleAdd() {
    if (!name.trim() || !path.trim()) return
    setSaving(true)
    setFormError(null)
    const res = await api<{ ok: boolean; error?: string }>('/', { method: 'POST', body: JSON.stringify({ name: name.trim(), path: path.trim() }) })
    if (!res.ok) {
      setFormError(res.error ?? 'Failed to add location')
    } else {
      setName('')
      setPath('')
      setValidation(null)
      await load()
    }
    setSaving(false)
  }

  async function handleDelete(loc: StorageLocation) {
    setDeleteTarget(null)
    const res = await api<{ ok: boolean; error?: string }>(`/${loc.id}`, { method: 'DELETE' })
    if (res.ok) await load()
    else setFormError(res.error ?? 'Failed to delete location')
  }

  async function handleSavePlexPath(loc: StorageLocation) {
    const plexPath = (plexPathDrafts[loc.id] ?? '').trim()
    if (!plexPath) {
      await api(`/${loc.id}/plex-mapping`, { method: 'DELETE' })
    } else {
      await api(`/${loc.id}/plex-mapping`, { method: 'PUT', body: JSON.stringify({ plexPath }) })
    }
    await load()
  }

  async function handleAssign(contentType: string, storageLocationId: string | null) {
    await api(`/content-types/${contentType}`, { method: 'PUT', body: JSON.stringify({ storageLocationId }) })
    await load()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" className="text-muted-foreground" />
      </div>
    )
  }

  const allChecksPass = validation?.ok && Object.values(validation.checks).every(Boolean)

  return (
    <div className="space-y-8 p-6">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <HardDrive className="size-5 text-brand" />
          Storage Locations
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Named storage roots (local, or a network/UNC path) that a content type's real files
          can live under instead of the default data root. Used for pointing content (e.g.
          YouTube downloads) at a location Plex can also see.
        </p>
      </div>

      {/* Existing locations */}
      {locations.length > 0 && (
        <div className="space-y-3">
          {locations.map(loc => (
            <div key={loc.id} className="rounded-card border border-border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{loc.name}</p>
                  <p className="text-xs text-muted-foreground font-mono truncate">{loc.path}</p>
                </div>
                <button
                  onClick={() => setDeleteTarget(loc)}
                  className="shrink-0 rounded-control p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Delete ${loc.name}`}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-border">
                <Link2 className="size-3.5 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  value={plexPathDrafts[loc.id] ?? loc.plexPath ?? ''}
                  onChange={e => setPlexPathDrafts(d => ({ ...d, [loc.id]: e.target.value }))}
                  placeholder="How Plex sees this path, e.g. /mnt/misc_videos"
                  className="flex-1 rounded-control border border-border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand"
                />
                <Button
                  onClick={() => handleSavePlexPath(loc)}
                  variant="secondary"
                  size="sm"
                  disabled={(plexPathDrafts[loc.id] ?? loc.plexPath ?? '') === (loc.plexPath ?? '')}
                >
                  Save
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add new location */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold">Add a storage location</h3>
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Name (e.g. Misc Videos Share)"
            className="rounded-control border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <input
            type="text"
            value={path}
            onChange={e => { setPath(e.target.value); setValidation(null); setFormError(null) }}
            placeholder="Absolute path, e.g. \\172.19.210.8\misc_videos\AppFolder"
            className="rounded-control border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand"
            onKeyDown={e => e.key === 'Enter' && handleValidate()}
          />
        </div>

        <Button onClick={handleValidate} disabled={!path.trim() || validating} variant="secondary" className="gap-2">
          {validating && <Spinner size="sm" className="text-current" />}
          Test access
        </Button>

        {validation && (
          <div className={cn(
            'rounded-card border p-4 space-y-2',
            validation.ok ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5',
          )}>
            <div className="grid grid-cols-2 gap-2">
              <CheckRow label="Read" ok={validation.checks.read} />
              <CheckRow label="Write" ok={validation.checks.write} />
              <CheckRow label="Rename" ok={validation.checks.rename} />
              <CheckRow label="Delete" ok={validation.checks.delete} />
            </div>
            {validation.error && <p className="text-sm text-destructive">{validation.error}</p>}
            {validation.ok && validation.freeFormatted && (
              <p className="text-xs text-muted-foreground">{validation.freeFormatted} free</p>
            )}
          </div>
        )}

        {formError && <p className="text-sm text-destructive">{formError}</p>}

        {allChecksPass && (
          <Button onClick={handleAdd} disabled={!name.trim() || saving} className="gap-2">
            <Plus className="size-4" />
            Add location
          </Button>
        )}
      </div>

      {/* Content type assignment */}
      <div className="space-y-3 pt-4 border-t border-border">
        <h3 className="text-sm font-semibold">Content storage assignment</h3>
        <p className="text-xs text-muted-foreground">
          Reassigning a content type off the default location makes that location its real
          store going forward; existing files aren't moved automatically.
        </p>
        {CONTENT_TYPES.map(ct => {
          const current = assignments.find(a => a.contentType === ct.key)?.storageLocationId ?? ''
          return (
            <div key={ct.key} className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">{ct.label}</span>
              <select
                value={current}
                onChange={e => handleAssign(ct.key, e.target.value || null)}
                className="rounded-control border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              >
                <option value="">Default (local data root)</option>
                {locations.map(loc => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
                ))}
              </select>
            </div>
          )
        })}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="Delete storage location?"
        description={`"${deleteTarget?.name}" will be removed along with its Plex path mapping. This does not delete any files.`}
        confirmLabel="Delete"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
      />
    </div>
  )
}
