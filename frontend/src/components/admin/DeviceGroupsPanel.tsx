import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2, Moon, Layers, Check, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'

// Admin → Devices → Settings groups. A built-in "Default" group holds the baseline
// settings; admin groups override them. Saving a group deploys to its online devices
// immediately (and an offline device pulls its group's settings when it reconnects).

export interface DeviceSettings { dimEnabled: boolean; dimPercent: number; dimAfterS: number; responseLength: string }
export interface DeviceGroup { id: string; name: string; isDefault: boolean; settings: Partial<DeviceSettings>; createdAt: number }

const DEFAULTS: DeviceSettings = { dimEnabled: false, dimPercent: 30, dimAfterS: 60, responseLength: 'inherit' }

const RESPONSE_OPTIONS: { value: string; label: string }[] = [
  { value: 'inherit', label: 'Use companion’s setting' },
  { value: 'auto', label: 'Automatic — short, expands when needed' },
  { value: 'brief', label: 'Brief — one or two sentences' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'detailed', label: 'Detailed' },
]
const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, opts)
  if (!r.ok) throw new Error(`Failed to load ${url}`)
  return r.json() as Promise<T>
}

// Honest deploy feedback: don't imply offline devices got the change now.
function deployMessage(deploy?: { online: number; total: number }): string {
  if (!deploy || deploy.total === 0) return 'Saved'
  const { online, total } = deploy
  const offline = total - online
  if (online === 0) return `Saved — none of the ${total} device${total > 1 ? 's' : ''} are online; they’ll sync when powered on`
  if (offline === 0) return `Saved — sent to ${online} device${online > 1 ? 's' : ''} now`
  return `Saved — sent to ${online} online now · ${offline} will sync when powered on`
}

export function DeviceGroupsPanel() {
  const qc = useQueryClient()
  const { data: groups = [], isLoading } = useQuery({ queryKey: ['pod-groups'], queryFn: () => getJSON<DeviceGroup[]>('/api/pod/groups') })
  const [del, setDel] = useState<DeviceGroup | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  // The Default group's stored values are the baseline custom groups inherit from.
  const baseline = { ...DEFAULTS, ...(groups.find((g) => g.isDefault)?.settings ?? {}) }
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['pod-groups'] })
    qc.invalidateQueries({ queryKey: ['pod-devices'] })
  }

  async function createGroup() {
    if (!newName.trim()) return
    setBusy(true)
    try {
      const r = await fetch('/api/pod/groups', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name: newName.trim() }) })
      if (!r.ok) throw new Error()
      setNewName(''); setAdding(false); invalidate()
    } catch { toast.error('Couldn’t create group') } finally { setBusy(false) }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Layers className="size-4 text-violet-500" />
        <h3 className="text-sm font-semibold">Settings groups</h3>
        <span className="text-xs text-muted-foreground">— deploy to every device in a group, live</span>
        {!adding && (
          <Button size="sm" variant="ghost" className="ml-auto h-8 gap-1.5 text-xs" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> New group
          </Button>
        )}
      </div>

      {adding && (
        <div className="flex items-center gap-2 rounded-2xl border border-border/40 bg-card/40 p-3">
          <Input autoFocus placeholder="Group name (e.g. Bedrooms)" value={newName}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createGroup() }} />
          <Button size="sm" onClick={createGroup} disabled={busy || !newName.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : 'Add'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setNewName('') }}>Cancel</Button>
        </div>
      )}

      {isLoading ? (
        <div className="py-6 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {groups.map((g) => (
            <GroupCard key={g.id} group={g} baseline={baseline} onChanged={invalidate} onDelete={() => setDel(g)} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => { if (!o) setDel(null) }}
        title="Delete this group?"
        description={del ? `Devices in "${del.name}" move back to Default and re-sync.` : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (del) {
            const r = await fetch(`/api/pod/groups/${del.id}`, { ...opts, method: 'DELETE' })
            if (r.ok) { toast.success('Group deleted'); invalidate() } else toast.error('Couldn’t delete')
          }
          setDel(null)
        }}
      />
    </section>
  )
}

function GroupCard({ group, baseline, onChanged, onDelete }: {
  group: DeviceGroup; baseline: DeviceSettings; onChanged: () => void; onDelete: () => void
}) {
  // Show effective values (group overrides on top of the baseline); saving stores them.
  const eff = { ...baseline, ...group.settings }
  const [name, setName] = useState(group.name)
  const [dimEnabled, setDimEnabled] = useState(eff.dimEnabled)
  const [dimPercent, setDimPercent] = useState(eff.dimPercent)
  const [dimAfterS, setDimAfterS] = useState(eff.dimAfterS)
  const [responseLength, setResponseLength] = useState(eff.responseLength)
  const [busy, setBusy] = useState(false)

  const dirty = name !== group.name || dimEnabled !== eff.dimEnabled || dimPercent !== eff.dimPercent
    || dimAfterS !== eff.dimAfterS || responseLength !== eff.responseLength

  async function save() {
    setBusy(true)
    try {
      const r = await fetch(`/api/pod/groups/${group.id}`, {
        ...opts, method: 'PUT', headers: J,
        body: JSON.stringify({ name, settings: { dimEnabled, dimPercent, dimAfterS, responseLength } }),
      })
      if (!r.ok) throw new Error()
      const { deploy } = (await r.json()) as { deploy?: { online: number; total: number } }
      toast.success(deployMessage(deploy))
      onChanged()
    } catch { toast.error('Couldn’t save') } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-4">
      <div className="flex items-center gap-2">
        {group.isDefault ? (
          <span className="text-sm font-semibold">Default</span>
        ) : (
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 max-w-[200px] text-sm font-semibold" />
        )}
        {group.isDefault && <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">baseline</span>}
        {!group.isDefault && (
          <Button size="icon" variant="ghost" className="ml-auto size-7 text-muted-foreground hover:text-destructive" onClick={onDelete} aria-label="Delete group">
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>

      {/* Response length — overrides the companion's own reply style on these devices */}
      <div className="space-y-2 rounded-xl bg-muted/40 p-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4 text-emerald-500" />
          <span className="text-sm font-medium">Response length</span>
        </div>
        <select
          value={responseLength}
          onChange={(e) => setResponseLength(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {RESPONSE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* Screen dimming */}
      <div className="space-y-2.5 rounded-xl bg-muted/40 p-3">
        <div className="flex items-center gap-2">
          <Moon className="size-4 text-sky-500" />
          <span className="text-sm font-medium">Dim screen when idle</span>
          <Switch className="ml-auto" checked={dimEnabled} onCheckedChange={setDimEnabled} />
        </div>
        <div className={`grid grid-cols-2 gap-3 transition-opacity ${dimEnabled ? '' : 'pointer-events-none opacity-40'}`}>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Brightness</span>
            <div className="flex items-center gap-1">
              <Input type="number" min={0} max={100} value={dimPercent}
                onChange={(e) => setDimPercent(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className="h-8" />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">After idle</span>
            <div className="flex items-center gap-1">
              <Input type="number" min={5} max={3600} value={dimAfterS}
                onChange={(e) => setDimAfterS(Math.max(5, Math.min(3600, Number(e.target.value) || 5)))} className="h-8" />
              <span className="text-xs text-muted-foreground">sec</span>
            </div>
          </label>
        </div>
      </div>

      <Button size="sm" className="ml-auto h-8 gap-1.5 text-xs" onClick={save} disabled={busy || !dirty}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <><Check className="size-3.5" /> Save & deploy</>}
      </Button>
    </div>
  )
}
