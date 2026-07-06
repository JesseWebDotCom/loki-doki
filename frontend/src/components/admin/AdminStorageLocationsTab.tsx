import { useEffect, useState } from 'react'
import { HardDrive, CheckCircle2, XCircle, Trash2, Plus, Link2, AlertTriangle, Pencil } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
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
  // Optional, not just always-present-in-practice: treat the network boundary as untrusted
  // and let TypeScript catch any future unguarded `.checks.x` access instead of assuming.
  checks?: { read: boolean; write: boolean; rename: boolean; delete: boolean }
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

// `path` must NOT start with '/' for the list/create root endpoint. Hono's `.route(prefix,
// subApp)` matches the subApp's own `app.get('/')` at exactly `prefix` (no trailing slash);
// `prefix/` is a distinct, unmatched path that 404s with a plain-text (non-JSON) body. That
// mismatch used to hang the whole tab forever: `r.json()` threw inside an unguarded
// Promise.all in load(), so setLoading(false) never ran. Every route here deliberately
// returns JSON even on 4xx (validation errors carry `{ok:false,error}`, read by callers),
// so this only throws when the BODY itself isn't parseable JSON at all (an unmatched route,
// a proxy error page, a backend crash), not on a normal 400.
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/admin/storage-locations${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  try {
    return (await r.json()) as T
  } catch {
    throw new Error(`Unexpected response (${r.status}) from /api/admin/storage-locations${path}`)
  }
}

// ── Main component ────────────────────────────────────────────────────────────

interface AdminStorageLocationsTabProps {
  /** Called after any change that could affect a content type's readiness (add/delete a
   *  location, set/clear a Plex mapping, reassign a content type). Lets an embedding
   *  parent (e.g. AdminPlexTab) refresh its own "is this actually ready" check instead of
   *  polling or going stale until the next full page load. */
  onChange?: () => void
}

export function AdminStorageLocationsTab({ onChange }: AdminStorageLocationsTabProps = {}) {
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [assignments, setAssignments] = useState<ContentTypeAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<AccessCheckResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [plexPathDrafts, setPlexPathDrafts] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<StorageLocation | null>(null)
  // Per-location errors (delete/edit), rendered ON that location's own card, not the shared
  // `formError` slot down in the Add-location form. That mismatch used to make a failed
  // delete look like nothing happened: the error was real, just showing somewhere the user
  // wasn't looking.
  const [locationErrors, setLocationErrors] = useState<Record<string, string>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDrafts, setEditDrafts] = useState<Record<string, { name: string; path: string }>>({})
  const [editSaving, setEditSaving] = useState(false)

  async function load() {
    try {
      const [locRes, ctRes] = await Promise.all([
        api<{ locations: StorageLocation[] }>(''),
        api<{ assignments: ContentTypeAssignment[] }>('/content-types'),
      ])
      setLocations(locRes.locations ?? [])
      setAssignments(ctRes.assignments ?? [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load storage locations')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleValidate() {
    if (!path.trim()) return
    setValidating(true)
    setValidation(null)
    setFormError(null)
    try {
      setValidation(await api<AccessCheckResult>('/validate', { method: 'POST', body: JSON.stringify({ path: path.trim() }) }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not test this path')
    } finally {
      setValidating(false)
    }
  }

  async function handleAdd() {
    if (!name.trim() || !path.trim()) return
    setSaving(true)
    setFormError(null)
    try {
      const res = await api<{ ok: boolean; error?: string }>('', { method: 'POST', body: JSON.stringify({ name: name.trim(), path: path.trim() }) })
      if (!res.ok) {
        setFormError(res.error ?? 'Failed to add location')
      } else {
        setName('')
        setPath('')
        setValidation(null)
        await load()
        onChange?.()
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add location')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(loc: StorageLocation) {
    setDeleteTarget(null)
    setLocationErrors(e => ({ ...e, [loc.id]: '' }))
    try {
      const res = await api<{ ok: boolean; error?: string }>(`/${loc.id}`, { method: 'DELETE' })
      if (res.ok) { await load(); onChange?.() }
      else setLocationErrors(e => ({ ...e, [loc.id]: res.error ?? 'Failed to delete location' }))
    } catch (err) {
      setLocationErrors(e => ({ ...e, [loc.id]: err instanceof Error ? err.message : 'Failed to delete location' }))
    }
  }

  function beginEdit(loc: StorageLocation) {
    setEditDrafts(d => ({ ...d, [loc.id]: { name: loc.name, path: loc.path } }))
    setEditingId(loc.id)
    setLocationErrors(e => ({ ...e, [loc.id]: '' }))
  }

  async function handleSaveEdit(loc: StorageLocation) {
    const draft = editDrafts[loc.id]
    if (!draft?.name.trim() || !draft.path.trim()) return
    setEditSaving(true)
    setLocationErrors(e => ({ ...e, [loc.id]: '' }))
    try {
      const res = await api<{ ok: boolean; error?: string }>(`/${loc.id}`, {
        method: 'PUT', body: JSON.stringify({ name: draft.name.trim(), path: draft.path.trim() }),
      })
      if (res.ok) {
        setEditingId(null)
        await load()
        onChange?.()
      } else {
        setLocationErrors(e => ({ ...e, [loc.id]: res.error ?? 'Failed to save changes' }))
      }
    } catch (err) {
      setLocationErrors(e => ({ ...e, [loc.id]: err instanceof Error ? err.message : 'Failed to save changes' }))
    } finally {
      setEditSaving(false)
    }
  }

  async function handleSavePlexPath(loc: StorageLocation) {
    const plexPath = (plexPathDrafts[loc.id] ?? '').trim()
    try {
      if (!plexPath) await api(`/${loc.id}/plex-mapping`, { method: 'DELETE' })
      else await api(`/${loc.id}/plex-mapping`, { method: 'PUT', body: JSON.stringify({ plexPath }) })
      await load()
      onChange?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the Plex path mapping')
    }
  }

  async function handleAssign(contentType: string, storageLocationId: string | null) {
    try {
      await api(`/content-types/${contentType}`, { method: 'PUT', body: JSON.stringify({ storageLocationId }) })
      await load()
      onChange?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the assignment')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" className="text-muted-foreground" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertTriangle className="size-6 text-destructive" />
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load() }}>Retry</Button>
      </div>
    )
  }

  const allChecksPass = validation?.ok && validation.checks != null && Object.values(validation.checks).every(Boolean)

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
              {editingId === loc.id ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={editDrafts[loc.id]?.name ?? ''}
                    onChange={e => setEditDrafts(d => ({ ...d, [loc.id]: { ...d[loc.id]!, name: e.target.value } }))}
                    placeholder="Name"
                    className="w-full rounded-control border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                  <input
                    type="text"
                    value={editDrafts[loc.id]?.path ?? ''}
                    onChange={e => setEditDrafts(d => ({ ...d, [loc.id]: { ...d[loc.id]!, path: e.target.value } }))}
                    placeholder="Absolute path"
                    className="w-full rounded-control border border-border bg-background px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                  <p className="text-xs text-muted-foreground">
                    Changing the path only works while nothing is stored here yet; content already
                    saved to the old path won't move with it.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={editSaving} onClick={() => handleSaveEdit(loc)}>
                      {editSaving && <Spinner size="sm" className="text-current mr-1" />}
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{loc.name}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">{loc.path}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => beginEdit(loc)}
                      className="rounded-control p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={`Edit ${loc.name}`}
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(loc)}
                      className="rounded-control p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Delete ${loc.name}`}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              )}

              {locationErrors[loc.id] && <p className="text-xs text-destructive">{locationErrors[loc.id]}</p>}

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
            {/* Defensive: never assume the server response is well-formed. A malformed/
                differently-shaped reply should show as an error, not crash the whole tab. */}
            {validation.checks && (
              <div className="grid grid-cols-2 gap-2">
                <CheckRow label="Read" ok={validation.checks.read} />
                <CheckRow label="Write" ok={validation.checks.write} />
                <CheckRow label="Rename" ok={validation.checks.rename} />
                <CheckRow label="Delete" ok={validation.checks.delete} />
              </div>
            )}
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
