import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Server, UserCheck, UserX, AlertTriangle, ChevronDown, Wand2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { AdminStorageLocationsTab } from '@/components/admin/AdminStorageLocationsTab'
import { PlexServerConnect } from '@/components/admin/PlexServerConnect'
import { PlexSetupWizard } from '@/components/admin/PlexSetupWizard'
import { LibraryPolicyEditor } from '@/components/media/LibraryPolicyEditor'
import { cn } from '@/lib/cn'
import {
  getPlexConfig,
  getAdminLibrarySections,
  getPlexAccounts,
  setPlexUserMapping,
  provisionLibrary,
  patchAdminLibraryPolicy,
  PLEX_EXPORT_SOURCES,
  type PlexConfigSummary,
  type PlexKnownAccount,
  type PlexLibrarySection,
} from '@/lib/plex/api'

interface StorageLocation {
  id: string
  name: string
  path: string
  plexPath: string | null
}

/** Per-content-type readiness: assigned to a non-default location AND that location has a
 *  Plex path mapping - the same two checks provisionUserLibrary() makes server-side. */
export type StorageReadiness = Record<string, { ready: boolean; issue: string | null }>

export async function checkStorageReadiness(): Promise<StorageReadiness | null> {
  const [locRes, ctRes] = await Promise.all([
    fetch('/api/admin/storage-locations', { credentials: 'include' }),
    fetch('/api/admin/storage-locations/content-types', { credentials: 'include' }),
  ])
  if (!locRes.ok || !ctRes.ok) return null
  const locData = await locRes.json() as { locations: StorageLocation[] }
  const ctData = await ctRes.json() as { assignments: Array<{ contentType: string; storageLocationId: string | null }> }
  const out: StorageReadiness = {}
  for (const { key, label } of PLEX_EXPORT_SOURCES) {
    const assignment = ctData.assignments.find(a => a.contentType === key)
    if (!assignment?.storageLocationId) {
      out[key] = { ready: false, issue: `${label} is still on the default local storage, which Plex can never see.` }
      continue
    }
    const loc = locData.locations.find(l => l.id === assignment.storageLocationId)
    out[key] = loc?.plexPath
      ? { ready: true, issue: null }
      : { ready: false, issue: `"${loc?.name ?? `${label}'s storage location`}" has no Plex path mapping set.` }
  }
  return out
}

/** Admin-side "which Plex account is this app user" picker. Mapping alone is enough to
 *  provision + share libraries (the share only needs the invited account's id); the
 *  user's own PIN sign-in stays the only path for personal watchlist/scrobble sync. */
export function PlexAccountSelect({ user, accounts, onChanged }: {
  user: { id: string; linked: boolean; plexAccountId: string | null; plexUsername: string | null }
  accounts: PlexKnownAccount[]
  onChanged: () => void
}) {
  const [saving, setSaving] = useState(false)
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Plex account</span>
      <select
        value={user.plexAccountId ?? ''}
        disabled={saving || accounts.length === 0}
        onChange={async e => {
          const id = e.target.value
          const account = accounts.find(a => a.id === id)
          setSaving(true)
          try {
            const ok = await setPlexUserMapping(user.id, account ? { id: account.id, username: account.username } : null)
            if (!ok) toast.error('Could not save the mapping')
            else onChanged()
          } finally {
            setSaving(false)
          }
        }}
        className="rounded-control border border-border bg-background px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-brand"
      >
        <option value="">{user.linked ? 'Their own sign-in' : 'Not mapped'}</option>
        {accounts.map(a => (
          <option key={a.id} value={a.id}>
            {a.name}{a.owner ? ' (owner)' : a.restricted ? ' (managed)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

export function AdminPlexTab() {
  const [cfg, setCfg] = useState<PlexConfigSummary | null>(null)
  const [librarySections, setLibrarySections] = useState<PlexLibrarySection[]>([])
  const [provisioning, setProvisioning] = useState<Set<string>>(new Set())   // `${userId}:${contentType}`
  const [storage, setStorage] = useState<StorageReadiness | null>(null)
  const [accounts, setAccounts] = useState<PlexKnownAccount[]>([])
  const [storageManagerOpen, setStorageManagerOpen] = useState(false)
  const storageManagerAutoOpened = useRef(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [expandedUser, setExpandedUser] = useState<string | null>(null)

  const load = useCallback(async () => {
    const d = await getPlexConfig()
    if (!d) {
      toast.error('Could not load Plex settings')
      return
    }
    setCfg(d)
    setLibrarySections(await getAdminLibrarySections())
    setStorage(await checkStorageReadiness())
    setAccounts(await getPlexAccounts())
  }, [])

  const provision = useCallback(async (userId: string, contentType: string) => {
    const key = `${userId}:${contentType}`
    setProvisioning(prev => new Set(prev).add(key))
    try {
      await provisionLibrary(userId, contentType)
      toast.success('Provisioning started, check back shortly for status')
      // The job runs in the background; poll once after a few seconds so a quick success shows up.
      setTimeout(() => { void load() }, 4000)
    } finally {
      setProvisioning(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }, [load])

  useEffect(() => { void load() }, [load])

  const anyStorageMissing = storage != null && PLEX_EXPORT_SOURCES.some(s => !storage[s.key]?.ready)
  const allStorageReady = storage != null && PLEX_EXPORT_SOURCES.every(s => storage[s.key]?.ready)

  // Open the embedded manager automatically the first time we learn setup isn't done yet.
  // Only once, so a user who deliberately collapses it later isn't fought on every re-check.
  useEffect(() => {
    if (anyStorageMissing && !storageManagerAutoOpened.current) {
      storageManagerAutoOpened.current = true
      setStorageManagerOpen(true)
    }
  }, [anyStorageMissing])

  if (!cfg) {
    return <SkeletonListRows count={4} className="p-5" />
  }

  const missingIssues = storage
    ? PLEX_EXPORT_SOURCES.filter(s => !storage[s.key]?.ready).map(s => storage[s.key]?.issue).filter(Boolean)
    : []

  return (
    <div className="flex flex-col max-w-3xl">
      {/* Page header */}
      <div className="flex items-start gap-3 p-5 pb-5">
        <div className="rounded-control bg-muted p-2 shrink-0">
          <Server className="size-5 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <h2 className="text-title">Plex</h2>
          <p className="text-sm text-muted-foreground">
            Configure the shared Plex Media Server. Each user then links their own Plex account in
            the Shows or Movies settings so their watchlist and progress stay personal; private video libraries only need the account mapping below.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setWizardOpen(true)} className="shrink-0">
          <Wand2 className="size-4 mr-1.5" /> Setup wizard
        </Button>
      </div>

      <div className="px-5 space-y-5">
        <PlexServerConnect hasToken={cfg.hasToken} initialBaseUrl={cfg.baseUrl} onSaved={() => void load()} />

        {/* Video library storage prerequisites. The manager lives right here, not in
            another admin section, since Plex is the only thing that needs it today. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Video library storage</CardTitle>
            <CardDescription>
              Add a network location Plex can see, give it a Plex path mapping, and assign the
              video content types to it (there's a one-click "assign all" below). Each source's
              per-user library exports under its own folder automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {storage == null ? (
              <Spinner size="sm" className="text-muted-foreground" />
            ) : allStorageReady ? (
              <div className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="size-4 shrink-0" /> Storage locations and Plex path mappings are configured for every source.
              </div>
            ) : (
              <div className="space-y-1">
                {[...new Set(missingIssues)].map(issue => (
                  <div key={issue} className="flex items-start gap-2 text-sm text-warning">
                    <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                    <span>{issue}</span>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => setStorageManagerOpen(o => !o)}
              className="flex w-full items-center justify-between rounded-control border border-border px-3 py-2 text-sm hover:bg-muted/50"
            >
              <span>{storageManagerOpen ? 'Hide' : 'Manage'} storage locations</span>
              <ChevronDown className={cn('size-4 transition-transform', storageManagerOpen && 'rotate-180')} />
            </button>
            {storageManagerOpen && (
              <div className="rounded-card border border-border">
                <AdminStorageLocationsTab onChange={load} />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Linked user accounts + per-source library provisioning */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Users &amp; libraries</CardTitle>
            <CardDescription>
              Map each user to a Plex account (or they sign in themselves in the Shows/Movies settings), then provision their private
              library per video source. Expand a user to provision libraries and set sync limits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
              {cfg.users.map(u => {
                const userSections = librarySections.filter(s => s.userId === u.id)
                const readyCount = userSections.filter(s => s.status === 'ready').length
                const expanded = expandedUser === u.id
                return (
                  <div key={u.id} className="text-sm">
                    <button
                      type="button"
                      onClick={() => setExpandedUser(expanded ? null : u.id)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/40 text-left"
                    >
                      <span>{u.name}</span>
                      <div className="flex items-center gap-3">
                        {u.linked ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-success">
                            <UserCheck className="size-3.5" /> Linked
                          </span>
                        ) : u.plexAccountId ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-success">
                            <UserCheck className="size-3.5" /> Mapped{u.plexUsername ? ` (${u.plexUsername})` : ''}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <UserX className="size-3.5" /> No Plex account
                          </span>
                        )}
                        {readyCount > 0 && (
                          <span className="text-xs text-muted-foreground">{readyCount} librar{readyCount === 1 ? 'y' : 'ies'}</span>
                        )}
                        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
                      </div>
                    </button>
                    {expanded && (
                      <div className="space-y-2 border-t border-border bg-muted/20 px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <PlexAccountSelect user={u} accounts={accounts} onChanged={() => void load()} />
                          {!u.linked && (
                            <p className="text-[11px] text-muted-foreground">
                              Mapping is enough for libraries; personal watchlist sync still needs their own sign-in (Shows or Movies settings).
                            </p>
                          )}
                        </div>
                        {PLEX_EXPORT_SOURCES.map(({ key, label }) => {
                          const section = userSections.find(s => s.contentType === key)
                          const provKey = `${u.id}:${key}`
                          const storageOk = storage?.[key]?.ready ?? false
                          const hasAccount = u.linked || !!u.plexAccountId
                          return (
                            <div key={key} className="space-y-1.5 rounded-card border border-border bg-card px-3 py-2">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-sm">{label}</span>
                                <div className="flex items-center gap-2">
                                  {section?.status === 'ready' && (
                                    <span className="inline-flex items-center gap-1 text-xs text-success">
                                      <CheckCircle2 className="size-3.5" /> Ready
                                    </span>
                                  )}
                                  {(section?.status === 'pending' || section?.status === 'provisioning') && (
                                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                      <Spinner size="sm" /> Provisioning…
                                    </span>
                                  )}
                                  {hasAccount && (!section || section.status === 'error') && (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={provisioning.has(provKey) || !storageOk}
                                      title={!storageOk ? 'Fix the storage setup above first' : undefined}
                                      onClick={() => provision(u.id, key)}
                                    >
                                      {provisioning.has(provKey) && <Spinner size="sm" className="text-current mr-1" />}
                                      {section?.status === 'error' ? 'Retry' : 'Provision'}
                                    </Button>
                                  )}
                                </div>
                              </div>
                              {section?.status === 'error' && section.error && (
                                <p className="text-xs text-destructive">{section.error}</p>
                              )}
                              {section?.status === 'ready' && (
                                <LibraryPolicyEditor
                                  section={section}
                                  onPatch={patch => patchAdminLibraryPolicy(section.id, patch)}
                                  onSaved={() => void load()}
                                />
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <PlexSetupWizard open={wizardOpen} onOpenChange={(o) => { setWizardOpen(o); if (!o) void load() }} />
    </div>
  )
}
