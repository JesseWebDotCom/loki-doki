import { useEffect, useState, useRef } from 'react'
import { FolderOpen, CheckCircle2, XCircle, AlertTriangle, Loader2, HardDrive, MoveRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'

// ── Types ─────────────────────────────────────────────────────────────────────

interface UserUsage {
  userId: string
  firstName: string
  slug: string
  bytes: number
  formatted: string
}

interface StorageStatus {
  root: string
  isDefault: boolean
  totalBytes: number
  totalFormatted: string
  freeBytes: number | null
  freeFormatted: string | null
  users: UserUsage[]
}

interface ValidationResult {
  ok: boolean
  checks: { read: boolean; write: boolean; rename: boolean; delete: boolean }
  error: string | null
  currentBytes: number
  currentFormatted: string
  freeBytes: number | null
  freeFormatted: string | null
  fitsInDestination: boolean
  spaceWarning: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok
        ? <CheckCircle2 className="size-4 text-green-500 shrink-0" />
        : <XCircle className="size-4 text-red-500 shrink-0" />}
      <span className={ok ? 'text-foreground' : 'text-destructive'}>{label}</span>
    </div>
  )
}

function UsageBar({ bytes, total, label, sublabel }: { bytes: number; total: number; label: string; sublabel: string }) {
  const pct = total > 0 ? Math.min(100, (bytes / total) * 100) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground text-xs">{sublabel}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function AdminStorageTab() {
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const [candidatePath, setCandidatePath] = useState('')
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<ValidationResult | null>(null)

  const [migrating, setMigrating] = useState(false)
  const [migrateError, setMigrateError] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()
    fetch('/api/admin/storage', { credentials: 'include', signal: ctrl.signal })
      .then(r => r.ok ? r.json() as Promise<StorageStatus> : null)
      .then(d => { if (!cancelled && d) setStatus(d) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; ctrl.abort() }
  }, [])

  async function handleValidate() {
    if (!candidatePath.trim()) return
    setValidating(true)
    setValidation(null)
    setMigrateError(null)
    try {
      const r = await fetch('/api/admin/storage/validate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: candidatePath.trim() }),
      })
      const data = await r.json() as ValidationResult
      setValidation(data)
    } catch {
      setValidation(null)
    } finally {
      setValidating(false)
    }
  }

  async function handleMigrate() {
    setMigrating(true)
    setMigrateError(null)
    setShowConfirm(false)
    try {
      const r = await fetch('/api/admin/storage/migrate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: candidatePath.trim() }),
      })
      const data = await r.json() as { ok: boolean; error?: string }
      if (!mountedRef.current) return
      if (!data.ok) {
        setMigrateError(data.error ?? 'Migration failed')
      } else {
        // Migration job enqueued — show in jobs widget
        setCandidatePath('')
        setValidation(null)
        // Refresh status
        const s = await fetch('/api/admin/storage', { credentials: 'include' }).then(r => r.ok ? r.json() as Promise<StorageStatus> : null)
        if (mountedRef.current && s) setStatus(s)
      }
    } catch {
      if (mountedRef.current) setMigrateError('Request failed')
    } finally {
      if (mountedRef.current) setMigrating(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const allChecksPass = validation?.ok && validation.checks.read && validation.checks.write && validation.checks.rename && validation.checks.delete

  return (
    <div className="space-y-8 p-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <HardDrive className="size-5 text-brand" />
          User Data Storage
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure where user content is stored — generated images, YouTube downloads, podcasts, and documents.
          This location can be a network share or external drive that survives app reinstalls.
        </p>
      </div>

      {/* Current location */}
      {status && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="flex items-start gap-3">
            <FolderOpen className="size-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{status.root}</p>
              <p className="text-xs text-muted-foreground">
                {status.isDefault ? 'Default location' : 'Custom location'} ·{' '}
                {status.totalFormatted} used
                {status.freeFormatted ? ` · ${status.freeFormatted} free` : ''}
              </p>
            </div>
          </div>

          {/* Per-user usage bars */}
          {status.users.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Per user</p>
              {status.users.map(u => (
                <UsageBar
                  key={u.userId}
                  label={u.firstName}
                  sublabel={`${u.formatted} · ${u.slug}/`}
                  bytes={u.bytes}
                  total={status.totalBytes}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Change location */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Change storage location</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Enter an absolute path (e.g. <code className="font-mono">/Volumes/NAS/loki-users</code>).
            We'll test access before moving anything.
          </p>
        </div>

        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={candidatePath}
            onChange={e => { setCandidatePath(e.target.value); setValidation(null); setMigrateError(null) }}
            placeholder="/absolute/path/to/user-data"
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            onKeyDown={e => e.key === 'Enter' && handleValidate()}
          />
          <button
            onClick={handleValidate}
            disabled={!candidatePath.trim() || validating}
            className="shrink-0 rounded-md bg-secondary px-4 py-2 text-sm font-medium hover:bg-secondary/80 disabled:opacity-50 flex items-center gap-2"
          >
            {validating && <Loader2 className="size-3.5 animate-spin" />}
            Test access
          </button>
        </div>

        {/* Validation result */}
        {validation && (
          <div className={cn(
            'rounded-lg border p-4 space-y-3',
            validation.ok ? 'border-green-500/30 bg-green-500/5' : 'border-destructive/30 bg-destructive/5',
          )}>
            <div className="grid grid-cols-2 gap-2">
              <CheckRow label="Read" ok={validation.checks.read} />
              <CheckRow label="Write" ok={validation.checks.write} />
              <CheckRow label="Rename" ok={validation.checks.rename} />
              <CheckRow label="Delete" ok={validation.checks.delete} />
            </div>

            {validation.spaceWarning && (
              <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <span>{validation.spaceWarning}</span>
              </div>
            )}

            {validation.error && (
              <p className="text-sm text-destructive">{validation.error}</p>
            )}

            {validation.ok && (
              <div className="pt-1 border-t border-border/50 space-y-1">
                <p className="text-xs text-muted-foreground">
                  Current data: <strong>{validation.currentFormatted}</strong>
                  {validation.freeFormatted ? ` · Destination free: ${validation.freeFormatted}` : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  All existing user data will be moved. A progress indicator will appear in the bottom-right corner.
                </p>
              </div>
            )}
          </div>
        )}

        {migrateError && (
          <p className="text-sm text-destructive">{migrateError}</p>
        )}

        {allChecksPass && (
          <button
            onClick={() => setShowConfirm(true)}
            disabled={migrating}
            className="flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
          >
            <MoveRight className="size-4" />
            Move data here
          </button>
        )}
      </div>

      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title="Move user data?"
        description={`All user content (${validation?.currentFormatted ?? ''}) will be copied to ${candidatePath}, then the old location will be removed. This runs in the background and you can track progress in the downloads widget.`}
        confirmLabel="Move data"
        onConfirm={handleMigrate}
      />
    </div>
  )
}
