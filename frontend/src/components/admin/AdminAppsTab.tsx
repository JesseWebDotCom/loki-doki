import { useCallback, useEffect, useState } from 'react'
import {
  Bell, Check, Plus, RefreshCw, Save, Store, Trash2,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { ToolsSection } from '@/components/admin/AdminFeaturesTab'
import { getWidgetMeta, canonicalWidgetId } from '@/lib/homeWidgets'
import { WidgetGalleryModal } from '@/components/home/WidgetGalleryModal'

// ── Types ─────────────────────────────────────────────────────────────────────

interface User {
  id: string
  firstName: string
  lastName: string
  email: string
  role: string
}

interface NotificationPayload {
  requestedBy: string
  requestedByName: string
  toolId: string
  toolName: string
  message: string
}

interface Notification {
  id: string
  type: string
  payload: NotificationPayload
  readAt: string | null
  createdAt: string
}

interface HomeWidget {
  toolId: string
  colSpan: 1 | 2
}

interface HomeRow {
  id: string
  cols: HomeWidget[]
}

interface HomeLayoutHeader {
  weather: boolean
  jokes: boolean
  sports: boolean
  locked: boolean
}

interface HomeLayout {
  header: HomeLayoutHeader
  canvas: HomeRow[]
}

// ── Canvas rows editor (shared) ───────────────────────────────────────────────

/** Append a widget to a row (or a brand-new row): pure, returns next canvas. */
function addWidgetToCanvas(canvas: HomeRow[], rowId: string | null, widgetId: string): HomeRow[] {
  if (rowId) {
    return canvas.map(row =>
      row.id === rowId && row.cols.length < 2
        ? { ...row, cols: [...row.cols, { toolId: widgetId, colSpan: 1 as const }] }
        : row,
    )
  }
  const id = `row-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return [...canvas, { id, cols: [{ toolId: widgetId, colSpan: 1 as const }] }]
}

function CanvasRowsEditor({
  canvas, onAdd, onRemove,
}: {
  canvas: HomeRow[]
  onAdd: (rowId: string | null, widgetId: string) => void
  onRemove: (rowId: string, toolId: string) => void
}) {
  // rowId target for the picker, or null = new row; undefined = closed
  const [pickerTarget, setPickerTarget] = useState<string | null | undefined>(undefined)

  const usedIds = new Set(canvas.flatMap(r => r.cols.map(c => canonicalWidgetId(c.toolId))))

  return (
    <div className="space-y-2">
      <p className="text-overline text-muted-foreground">Canvas Widgets</p>

      {canvas.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/40">No widgets yet. Add one below.</p>
      ) : (
        <div className="space-y-2">
          {canvas.map(row => (
            <div key={row.id} className="flex flex-wrap items-center gap-1.5 rounded-control border border-border/40 bg-background/40 px-3 py-2">
              {row.cols.map(widget => {
                const meta = getWidgetMeta(widget.toolId)
                const Icon = meta?.icon
                return (
                  <span
                    key={widget.toolId}
                    className="inline-flex items-center gap-1.5 rounded-control border border-border/60 bg-card px-2 py-1 text-[11px] text-foreground/80"
                  >
                    {Icon && (
                      <span
                        className="flex size-4 items-center justify-center rounded"
                        style={{ background: meta!.gradient }}
                      >
                        <Icon className="size-2.5 text-white" />
                      </span>
                    )}
                    {meta?.title ?? widget.toolId}
                    {widget.colSpan === 2 && (
                      <span className="text-[9px] text-muted-foreground/40">wide</span>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemove(row.id, widget.toolId)}
                      className="ml-0.5 text-muted-foreground/40 hover:text-destructive transition-colors"
                      aria-label="Remove widget"
                    >
                      <Trash2 className="size-2.5" />
                    </button>
                  </span>
                )
              })}
              {row.cols.length < 2 && (
                <button
                  type="button"
                  onClick={() => setPickerTarget(row.id)}
                  className="inline-flex items-center gap-1 rounded-control border border-dashed border-border/50 px-2 py-1 text-[11px] text-muted-foreground/50 hover:border-brand/60 hover:text-foreground/70 transition-colors"
                >
                  <Plus className="size-2.5" /> Add
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setPickerTarget(null)}
        className="flex w-full items-center justify-center gap-1.5 rounded-control border-2 border-dashed border-border/40 py-2.5 text-[11px] text-muted-foreground/50 hover:border-brand/60 hover:text-foreground/70 transition-colors"
      >
        <Plus className="size-3" /> Add widget row
      </button>

      {pickerTarget !== undefined && (
        <WidgetGalleryModal
          usedIds={usedIds}
          onPick={id => onAdd(pickerTarget, id)}
          onClose={() => setPickerTarget(undefined)}
        />
      )}
    </div>
  )
}

// ── Toggle switch ─────────────────────────────────────────────────────────────

function ToggleSwitch({ checked, disabled, onChange }: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative shrink-0 h-5 w-9 rounded-full transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
        checked ? 'bg-brand' : 'bg-foreground/15',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className={cn(
        'absolute top-[2px] size-4 rounded-full bg-white shadow-sm transition-transform duration-200',
        checked ? 'left-[18px]' : 'left-[2px]',
      )} />
    </button>
  )
}

// ── Section panel ─────────────────────────────────────────────────────────────

// A flat settings section. `openSignal`/`defaultOpen` accepted for back-compat, ignored.
function SectionPanel({
  title, description, children, id,
}: { title: string; description?: string; children: React.ReactNode; id?: string; openSignal?: string; defaultOpen?: boolean }) {
  return (
    <Card variant="surface" id={id} className="scroll-mt-20 border-border/60">
      <div className="px-5 py-4 border-b border-border/40">
        <p className="text-sm font-semibold">{title}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </Card>
  )
}

// ── Section 1: Install Requests ───────────────────────────────────────────────

function InstallRequestsSection({ openSignal }: { openSignal?: string }) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<Set<string>>(new Set())

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/notifications', { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<{ notifications: Notification[] }> : { notifications: [] })
      .then(d => {
        const pending = (d.notifications ?? []).filter(
          n => n.type === 'install_request' && n.readAt === null,
        )
        setNotifications(pending)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function markRead(id: string) {
    await fetch(`/api/notifications/${id}/read`, { method: 'PATCH', credentials: 'include' }).catch(() => {})
    setNotifications(prev => prev.filter(n => n.id !== id))
  }

  async function handleApprove(n: Notification) {
    setActing(prev => new Set(prev).add(n.id))
    try {
      await fetch(`/api/tools/${n.payload.toolId}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
        credentials: 'include',
      })
      await markRead(n.id)
    } finally {
      setActing(prev => { const next = new Set(prev); next.delete(n.id); return next })
    }
  }

  async function handleDismiss(n: Notification) {
    setActing(prev => new Set(prev).add(n.id))
    try { await markRead(n.id) }
    finally { setActing(prev => { const next = new Set(prev); next.delete(n.id); return next }) }
  }

  function formatTs(ts: string) {
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ts))
    } catch { return ts }
  }

  return (
    <SectionPanel
      id="requests" openSignal={openSignal} defaultOpen={false}
      title="Install Requests"
      description="Pending requests from users to enable apps."
    >
      {loading ? (
        <div className="flex items-center gap-2 py-2">
          <Spinner size="sm" className="text-muted-foreground/40" />
          <span className="text-xs text-muted-foreground/40">Loading...</span>
        </div>
      ) : notifications.length === 0 ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground/50">
          <Bell className="size-3.5" />
          No pending requests
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map(n => (
            <div key={n.id} className="rounded-card border border-border/50 bg-background/50 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-xs font-semibold leading-tight">{n.payload.toolName}</p>
                    <span className="text-[10px] text-muted-foreground/50">requested by {n.payload.requestedByName}</span>
                  </div>
                  {n.payload.message && (
                    <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{n.payload.message}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/40 mt-1">{formatTs(n.createdAt)}</p>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={acting.has(n.id)}
                    onClick={() => void handleDismiss(n)}
                  >
                    Dismiss
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={acting.has(n.id)}
                    onClick={() => void handleApprove(n)}
                  >
                    Approve
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionPanel>
  )
}

// ── Section 2: Default Home Layout ────────────────────────────────────────────

export function DefaultHomeLayoutSection({ openSignal }: { openSignal?: string }) {
  const [layout, setLayout] = useState<HomeLayout | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/home-layout/default', { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<{ layout: HomeLayout }> : null)
      .then(d => { if (d) setLayout(d.layout) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  function toggleHeader(key: keyof Omit<HomeLayoutHeader, 'locked'>) {
    setLayout(prev => prev ? { ...prev, header: { ...prev.header, [key]: !prev.header[key] } } : prev)
    setSaved(false)
  }

  function removeCanvasWidget(rowId: string, toolId: string) {
    setLayout(prev => {
      if (!prev) return prev
      const canvas = prev.canvas
        .map(row => row.id === rowId ? { ...row, cols: row.cols.filter(w => w.toolId !== toolId) } : row)
        .filter(row => row.cols.length > 0)
      return { ...prev, canvas }
    })
    setSaved(false)
  }

  function addCanvasWidget(rowId: string | null, widgetId: string) {
    setLayout(prev => prev ? { ...prev, canvas: addWidgetToCanvas(prev.canvas, rowId, widgetId) } : prev)
    setSaved(false)
  }

  async function save() {
    if (!layout) return
    setSaving(true)
    try {
      await fetch('/api/home-layout/default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(layout),
        credentials: 'include',
      })
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const HEADER_TOGGLES: { key: keyof Omit<HomeLayoutHeader, 'locked'>; label: string }[] = [
    { key: 'weather', label: 'Weather' },
    { key: 'jokes',   label: 'Joke of the Day' },
    { key: 'sports',  label: 'Sports Score' },
  ]

  return (
    <SectionPanel
      id="home-layout" openSignal={openSignal} defaultOpen={false}
      title="Default Home Layout"
      description="Set the layout new users see. Users can override this unless locked."
    >
      {loading ? (
        <div className="flex items-center gap-2 py-2">
          <Spinner size="sm" className="text-muted-foreground/40" />
          <span className="text-xs text-muted-foreground/40">Loading...</span>
        </div>
      ) : !layout ? (
        <p className="text-xs text-muted-foreground/50">Could not load layout.</p>
      ) : (
        <div className="space-y-5">
          {/* Header toggles */}
          <div className="space-y-2">
            <p className="text-overline text-muted-foreground">Header Widgets</p>
            <div className="space-y-2">
              {HEADER_TOGGLES.map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between gap-3">
                  <span className="text-xs text-foreground/80">{label}</span>
                  <ToggleSwitch checked={layout.header[key]} onChange={() => toggleHeader(key)} />
                </div>
              ))}
            </div>
          </div>

          {/* Canvas widgets */}
          <CanvasRowsEditor
            canvas={layout.canvas}
            onAdd={addCanvasWidget}
            onRemove={removeCanvasWidget}
          />

          {/* Save */}
          <div className="flex items-center justify-between gap-3 pt-1">
            {saved && (
              <span className="flex items-center gap-1 text-[11px] text-success">
                <Check className="size-3" /> Saved
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={load}
              >
                <RefreshCw className="size-3" /> Reset
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? <Spinner size="sm" className="text-current" /> : <Save className="size-3" />}
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </SectionPanel>
  )
}

// ── Section 4: Per-User Home Layout ──────────────────────────────────────────

export function PerUserHomeLayoutSection() {
  const [users, setUsers] = useState<User[]>([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState<string>('')

  const [userLayout, setUserLayout] = useState<HomeLayout | null>(null)
  const [locked, setLocked] = useState(false)
  const [layoutLoading, setLayoutLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [defaultLayout, setDefaultLayout] = useState<HomeLayout | null>(null)

  // Load users and system default layout on mount
  useEffect(() => {
    Promise.all([
      fetch('/api/users', { credentials: 'include' }).then(r => r.ok ? r.json() as Promise<User[]> : []),
      fetch('/api/home-layout/default', { credentials: 'include' }).then(r => r.ok ? r.json() as Promise<{ layout: HomeLayout }> : null),
    ])
      .then(([usersData, defaultData]) => {
        setUsers(Array.isArray(usersData) ? usersData : [])
        if (defaultData) setDefaultLayout(defaultData.layout)
      })
      .catch(() => {})
      .finally(() => setUsersLoading(false))
  }, [])

  // Load user layout when selection changes
  useEffect(() => {
    if (!selectedUserId) { setUserLayout(null); setLocked(false); return }
    setLayoutLoading(true)
    setSaved(false)
    fetch(`/api/home-layout/users/${selectedUserId}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<{ layout: HomeLayout | null; locked: boolean }> : null)
      .then(d => {
        if (d) {
          setUserLayout(d.layout)
          setLocked(d.locked)
        }
      })
      .catch(() => {})
      .finally(() => setLayoutLoading(false))
  }, [selectedUserId])

  function toggleHeader(key: keyof Omit<HomeLayoutHeader, 'locked'>) {
    setUserLayout(prev => prev ? { ...prev, header: { ...prev.header, [key]: !prev.header[key] } } : prev)
    setSaved(false)
  }

  // Editing a user with no custom layout promotes the system default to a
  // custom copy first, so the admin's edits don't mutate the shared default.
  function removeCanvasWidget(rowId: string, toolId: string) {
    setUserLayout(prev => {
      const base = prev ?? defaultLayout
      if (!base) return prev
      const canvas = base.canvas
        .map(row => row.id === rowId ? { ...row, cols: row.cols.filter(w => w.toolId !== toolId) } : row)
        .filter(row => row.cols.length > 0)
      return { ...base, canvas }
    })
    setSaved(false)
  }

  function addCanvasWidget(rowId: string | null, widgetId: string) {
    setUserLayout(prev => {
      const base = prev ?? defaultLayout
      if (!base) return prev
      return { ...base, canvas: addWidgetToCanvas(base.canvas, rowId, widgetId) }
    })
    setSaved(false)
  }

  async function save() {
    if (!selectedUserId) return
    setSaving(true)
    try {
      await fetch(`/api/home-layout/users/${selectedUserId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: userLayout ?? undefined, locked }),
        credentials: 'include',
      })
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  async function resetToDefault() {
    if (!selectedUserId || !defaultLayout) return
    setUserLayout(defaultLayout)
    setSaved(false)
  }

  const HEADER_TOGGLES: { key: keyof Omit<HomeLayoutHeader, 'locked'>; label: string }[] = [
    { key: 'weather', label: 'Weather' },
    { key: 'jokes',   label: 'Joke of the Day' },
    { key: 'sports',  label: 'Sports Score' },
  ]

  const effectiveLayout = userLayout ?? defaultLayout

  return (
    <SectionPanel
      title="Per-User Home Layout"
      description="Override a specific user's home layout or lock it to prevent changes."
    >
      {usersLoading ? (
        <div className="flex items-center gap-2 py-2">
          <Spinner size="sm" className="text-muted-foreground/40" />
          <span className="text-xs text-muted-foreground/40">Loading users...</span>
        </div>
      ) : (
        <div className="space-y-4">
          {/* User select */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/70">User</label>
            <select
              value={selectedUserId}
              onChange={e => setSelectedUserId(e.target.value)}
              className="w-full rounded-control border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
            >
              <option value="">Select a user...</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>
                  {u.firstName} {u.lastName} {u.email ? `(${u.email})` : ''}
                </option>
              ))}
            </select>
          </div>

          {selectedUserId && (
            layoutLoading ? (
              <div className="flex items-center gap-2 py-2">
                <Spinner size="sm" className="text-muted-foreground/40" />
                <span className="text-xs text-muted-foreground/40">Loading layout...</span>
              </div>
            ) : (
              <div className="space-y-5">
                {/* Locked toggle */}
                <div className="flex items-center justify-between gap-3 rounded-card border border-border/50 bg-background/50 px-4 py-3">
                  <div>
                    <p className="text-xs font-semibold">Lock layout</p>
                    <p className="text-[11px] text-muted-foreground">Prevent this user from changing their home layout.</p>
                  </div>
                  <ToggleSwitch checked={locked} onChange={v => { setLocked(v); setSaved(false) }} />
                </div>

                {/* Note if using default layout */}
                {!userLayout && (
                  <p className="text-[11px] text-muted-foreground/50 italic">
                    Showing system default layout. Edits below will create a custom layout for this user.
                  </p>
                )}

                {/* Header toggles */}
                {effectiveLayout && (
                  <>
                    <div className="space-y-2">
                      <p className="text-overline text-muted-foreground">Header Widgets</p>
                      <div className="space-y-2">
                        {HEADER_TOGGLES.map(({ key, label }) => (
                          <div key={key} className="flex items-center justify-between gap-3">
                            <span className="text-xs text-foreground/80">{label}</span>
                            <ToggleSwitch
                              checked={effectiveLayout.header[key]}
                              onChange={() => {
                                if (!userLayout && defaultLayout) setUserLayout(defaultLayout)
                                toggleHeader(key)
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Canvas widgets */}
                    <CanvasRowsEditor
                      canvas={effectiveLayout.canvas}
                      onAdd={addCanvasWidget}
                      onRemove={removeCanvasWidget}
                    />
                  </>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between gap-3 pt-1">
                  {saved && (
                    <span className="flex items-center gap-1 text-[11px] text-success">
                      <Check className="size-3" /> Saved
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {defaultLayout && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void resetToDefault()}
                      >
                        <RefreshCw className="size-3" /> Reset to default
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving}
                      onClick={() => void save()}
                    >
                      {saving ? <Spinner size="sm" className="text-current" /> : <Save className="size-3" />}
                      Save
                    </Button>
                  </div>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </SectionPanel>
  )
}

// ── AdminAppsTab ──────────────────────────────────────────────────────────────

export function AdminAppsTab({ openSignal }: { openSignal?: string } = {}) {
  const [searchParams] = useSearchParams()
  const focusToolId = searchParams.get('tool') ?? undefined

  return (
    <div>
      <div className="px-5 pt-5 pb-4 border-b border-border/40">
        <div className="flex items-center gap-2.5">
          <Store className="size-5 text-brand" />
          <div>
            <h2 className="text-title">Apps</h2>
            <p className="text-xs text-muted-foreground">Manage apps and install requests.</p>
          </div>
        </div>
      </div>

      <div className="px-5 pt-6 pb-8 space-y-3">
        <InstallRequestsSection openSignal={openSignal} />
        <SectionPanel
          id="app-settings" openSignal={openSignal} defaultOpen={false}
          title="App Settings"
          description="Enable apps, set API keys and options, and control who can use each one."
        >
          <ToolsSection query="" focusToolId={focusToolId} />
        </SectionPanel>
        <DefaultHomeLayoutSection openSignal={openSignal} />
        <PerUserHomeLayoutSection />
      </div>
    </div>
  )
}
