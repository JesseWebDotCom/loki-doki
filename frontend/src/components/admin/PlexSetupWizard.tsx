// Guided Plex sync setup - an optional Dialog wizard over the same granular admin
// surfaces (AdminPlexTab / AdminStorageLocationsTab): connect the server, map storage,
// check user links, then pick which libraries to provision per user with a default
// sync policy. Phase machine in the FlashDeviceWizard style, not the full-page SetupWizard.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, AlertTriangle, UserCheck, UserX, RefreshCw } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { PlexServerConnect } from '@/components/admin/PlexServerConnect'
import { AdminStorageLocationsTab } from '@/components/admin/AdminStorageLocationsTab'
import { checkStorageReadiness, PlexAccountSelect, type StorageReadiness } from '@/components/admin/AdminPlexTab'
import {
  getPlexConfig,
  getAdminLibrarySections,
  getPlexAccounts,
  provisionLibrary,
  patchAdminLibraryPolicy,
  PLEX_EXPORT_SOURCES,
  type PlexConfigSummary,
  type PlexKnownAccount,
  type PlexLibrarySection,
  type LibraryPolicyPatch,
} from '@/lib/plex/api'

type Phase = 'connect' | 'storage' | 'users' | 'libraries'
const PHASES: Array<{ id: Phase; label: string }> = [
  { id: 'connect', label: 'Connect' },
  { id: 'storage', label: 'Storage' },
  { id: 'users', label: 'Users' },
  { id: 'libraries', label: 'Libraries' },
]

const RECENT_CHOICES = [5, 10, 25, 50, 100]

interface PlexSetupWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PlexSetupWizard({ open, onOpenChange }: PlexSetupWizardProps) {
  const [phase, setPhase] = useState<Phase>('connect')
  const [cfg, setCfg] = useState<PlexConfigSummary | null>(null)
  const [connected, setConnected] = useState(false)
  const [storage, setStorage] = useState<StorageReadiness | null>(null)
  const [sections, setSections] = useState<PlexLibrarySection[]>([])
  const [accounts, setAccounts] = useState<PlexKnownAccount[]>([])
  const [refreshing, setRefreshing] = useState(false)

  // Libraries step: users × sources selection + default policy.
  const [selected, setSelected] = useState<Set<string>>(new Set())   // `${userId}:${source}`
  const [defaultMode, setDefaultMode] = useState<'all' | 'recent'>('all')
  const [defaultRecent, setDefaultRecent] = useState(25)
  const [defaultRemoveWatched, setDefaultRemoveWatched] = useState(false)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const policyPatched = useRef<Set<string>>(new Set())
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [d, s, secs, accts] = await Promise.all([getPlexConfig(), checkStorageReadiness(), getAdminLibrarySections(), getPlexAccounts()])
      if (d) {
        setCfg(d)
        setConnected(d.hasToken && !!d.baseUrl)
      }
      setStorage(s)
      setSections(secs)
      setAccounts(accts)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setPhase('connect')
      setDone(false)
      policyPatched.current = new Set()
      void refresh()
    }
    return () => { if (pollTimer.current) clearInterval(pollTimer.current) }
  }, [open, refresh])

  // Pre-select every source for every user with a Plex account (own sign-in OR admin
  // mapping - sharing only needs the account id) when entering the libraries step.
  const enterLibraries = useCallback(() => {
    const next = new Set<string>()
    for (const u of cfg?.users ?? []) {
      if (!u.linked && !u.plexAccountId) continue
      for (const { key } of PLEX_EXPORT_SOURCES) {
        const existing = sections.find(s => s.userId === u.id && s.contentType === key)
        if (existing?.status !== 'ready') next.add(`${u.id}:${key}`)
      }
    }
    setSelected(next)
    setPhase('libraries')
  }, [cfg, sections])

  const defaultPolicy = useCallback((): LibraryPolicyPatch => ({
    syncMode: defaultMode,
    ...(defaultMode === 'recent' ? { syncRecentCount: defaultRecent } : {}),
    removeWatched: defaultRemoveWatched,
  }), [defaultMode, defaultRecent, defaultRemoveWatched])

  const runProvisioning = useCallback(async () => {
    if (!selected.size) return
    setRunning(true)
    for (const key of selected) {
      const [userId, contentType] = key.split(':') as [string, string]
      await provisionLibrary(userId, contentType)
    }
    // The jobs run in the background - poll section status and stamp the chosen default
    // policy onto each row as it appears (removeWatched never applies to 'mine').
    pollTimer.current = setInterval(async () => {
      const secs = await getAdminLibrarySections()
      setSections(secs)
      for (const key of selected) {
        const [userId, contentType] = key.split(':') as [string, string]
        const section = secs.find(s => s.userId === userId && s.contentType === contentType)
        if (section && !policyPatched.current.has(key)) {
          policyPatched.current.add(key)
          const patch = defaultPolicy()
          if (contentType === 'mine') delete patch.removeWatched
          void patchAdminLibraryPolicy(section.id, patch)
        }
      }
      const settled = [...selected].every(key => {
        const [userId, contentType] = key.split(':') as [string, string]
        const s = secs.find(x => x.userId === userId && x.contentType === contentType)
        return s?.status === 'ready' || s?.status === 'error'
      })
      if (settled) {
        if (pollTimer.current) clearInterval(pollTimer.current)
        setRunning(false)
        setDone(true)
      }
    }, 3000)
  }, [selected, defaultPolicy])

  const allStorageReady = storage != null && PLEX_EXPORT_SOURCES.every(s => storage[s.key]?.ready)
  const phaseIdx = PHASES.findIndex(p => p.id === phase)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!running) onOpenChange(o) }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Plex sync setup</DialogTitle>
          <DialogDescription>
            Connect Plex, map storage, and provision each user's private video libraries.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5">
          {PHASES.map((p, i) => (
            <div key={p.id} className="flex items-center gap-1.5">
              {i > 0 && <div className="h-px w-4 bg-border" />}
              <span className={cn(
                'rounded-full px-2.5 py-1 text-xs',
                i < phaseIdx && 'bg-success/15 text-success',
                i === phaseIdx && 'bg-brand/15 text-brand font-medium',
                i > phaseIdx && 'bg-muted text-muted-foreground',
              )}>
                {p.label}
              </span>
            </div>
          ))}
        </div>

        {phase === 'connect' && (
          <div className="space-y-4">
            {connected ? (
              <div className="flex items-center gap-2 rounded-card border border-success/30 bg-success/5 px-4 py-3 text-sm">
                <CheckCircle2 className="size-4 text-success shrink-0" />
                A Plex server is connected{cfg?.baseUrl ? ` (${cfg.baseUrl})` : ''}. You can re-connect below or continue.
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">First, connect the household's Plex Media Server.</p>
            )}
            <PlexServerConnect
              compact
              hasToken={!!cfg?.hasToken}
              initialBaseUrl={cfg?.baseUrl ?? ''}
              onSaved={(ok) => { setConnected(ok); void refresh() }}
            />
            <div className="flex justify-end">
              <Button onClick={() => setPhase('storage')} disabled={!connected}>Continue</Button>
            </div>
          </div>
        )}

        {phase === 'storage' && (
          <div className="space-y-4">
            {allStorageReady ? (
              <div className="flex items-center gap-2 rounded-card border border-success/30 bg-success/5 px-4 py-3 text-sm">
                <CheckCircle2 className="size-4 text-success shrink-0" />
                Storage locations and Plex path mappings are configured for every video source.
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-card border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
                <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
                <span>
                  Add a storage location Plex can also see, give it a Plex path mapping, then use
                  "Assign every video type at once" below.
                </span>
              </div>
            )}
            <div className="rounded-card border border-border">
              <AdminStorageLocationsTab onChange={() => void refresh()} />
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setPhase('connect')}>Back</Button>
              <Button onClick={() => setPhase('users')} disabled={!allStorageReady}>Continue</Button>
            </div>
          </div>
        )}

        {phase === 'users' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Pick which Plex account each user's private libraries are shared to - the list
              comes from your server's own accounts (owner, friends, Plex Home users), so no
              one has to sign in first. A user's own PIN sign-in
              (<span className="font-medium text-foreground">Shows or Movies settings</span>) is only needed
              for personal watchlist and watched-progress sync.
            </p>
            <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
              {(cfg?.users ?? []).map(u => (
                <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="flex items-center gap-2">
                    {u.name}
                    {u.linked ? (
                      <span className="inline-flex items-center gap-1 text-xs text-success"><UserCheck className="size-3.5" /> Linked</span>
                    ) : !u.plexAccountId ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><UserX className="size-3.5" /></span>
                    ) : null}
                  </span>
                  <PlexAccountSelect user={u} accounts={accounts} onChanged={() => void refresh()} />
                </div>
              ))}
            </div>
            {accounts.length === 0 && (
              <p className="text-xs text-warning">
                No Plex accounts found - invite family members to your Plex server (or create
                Plex Home users) first, then hit Refresh.
              </p>
            )}
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => setPhase('storage')}>Back</Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => void refresh()} disabled={refreshing}>
                  {refreshing ? <Spinner size="sm" className="text-current mr-1.5" /> : <RefreshCw className="size-4 mr-1.5" />}
                  Refresh
                </Button>
                <Button onClick={enterLibraries} disabled={!(cfg?.users ?? []).some(u => u.linked || u.plexAccountId)}>Continue</Button>
              </div>
            </div>
          </div>
        )}

        {phase === 'libraries' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Pick which libraries to create. Each becomes a private Plex library only that user can see.
            </p>

            {/* Users × sources matrix */}
            <div className="overflow-x-auto rounded-card border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">User</th>
                    {PLEX_EXPORT_SOURCES.map(s => (
                      <th key={s.key} className="px-2 py-2 text-center font-medium">{s.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(cfg?.users ?? []).filter(u => u.linked || u.plexAccountId).map(u => (
                    <tr key={u.id}>
                      <td className="px-3 py-2">{u.name}</td>
                      {PLEX_EXPORT_SOURCES.map(s => {
                        const key = `${u.id}:${s.key}`
                        const section = sections.find(x => x.userId === u.id && x.contentType === s.key)
                        if (section?.status === 'ready') {
                          return <td key={s.key} className="px-2 py-2 text-center"><CheckCircle2 className="mx-auto size-4 text-success" /></td>
                        }
                        if (running || done) {
                          return (
                            <td key={s.key} className="px-2 py-2 text-center">
                              {!selected.has(key) ? <span className="text-muted-foreground">-</span>
                                : section?.status === 'error' ? <AlertTriangle className="mx-auto size-4 text-destructive" />
                                : <Spinner size="sm" className="mx-auto" />}
                            </td>
                          )
                        }
                        return (
                          <td key={s.key} className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={selected.has(key)}
                              onChange={e => setSelected(prev => {
                                const next = new Set(prev)
                                if (e.target.checked) next.add(key); else next.delete(key)
                                return next
                              })}
                              className="size-4 accent-[var(--brand)]"
                            />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Default policy for the new libraries */}
            {!running && !done && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-border px-3 py-2.5 text-xs">
                <span className="font-medium text-sm">Default limits</span>
                <label className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Keep in Plex</span>
                  <select
                    value={defaultMode === 'recent' ? String(defaultRecent) : 'all'}
                    onChange={e => {
                      if (e.target.value === 'all') setDefaultMode('all')
                      else { setDefaultMode('recent'); setDefaultRecent(Number(e.target.value)) }
                    }}
                    className="rounded-control border border-border bg-background px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-brand"
                  >
                    <option value="all">All videos</option>
                    {RECENT_CHOICES.map(n => <option key={n} value={n}>{`Most recent ${n} per creator`}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1.5">
                  <Switch checked={defaultRemoveWatched} onCheckedChange={setDefaultRemoveWatched} />
                  <span className="text-muted-foreground">Delete after watching</span>
                </label>
              </div>
            )}

            {done && (
              <div className="flex items-center gap-2 rounded-card border border-success/30 bg-success/5 px-4 py-3 text-sm">
                <CheckCircle2 className="size-4 text-success shrink-0" />
                Provisioning finished. Libraries with errors can be retried from the Plex admin page.
              </div>
            )}

            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => setPhase('users')} disabled={running}>Back</Button>
              {done ? (
                <Button onClick={() => onOpenChange(false)}>Close</Button>
              ) : (
                <Button
                  onClick={() => { void runProvisioning().catch(() => toast.error('Provisioning failed to start')) }}
                  disabled={running || selected.size === 0}
                >
                  {running && <Spinner size="sm" className="text-current mr-1.5" />}
                  {running ? 'Provisioning…' : `Provision ${selected.size} librar${selected.size === 1 ? 'y' : 'ies'}`}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
