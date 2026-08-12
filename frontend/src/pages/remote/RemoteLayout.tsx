import { useCallback, useEffect, useState } from 'react'
import { TerminalSquare, Monitor, MonitorPlay, X, ServerCog, Plus, Trash2, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'
import { RemoteSessionsProvider, useRemoteSessions } from '@/components/remote/RemoteSessionsProvider'
import { ConnectionSidebar } from '@/components/remote/ConnectionSidebar'
import { SessionPane } from '@/components/remote/SessionPane'
import { MachineEditorDialog } from '@/components/remote/MachineEditorDialog'
import { PinDialog } from '@/components/remote/PinDialog'
import { ServerDesktopDialog } from '@/components/remote/ServerDesktopDialog'
import {
  getHosts, getFolders, getSnippets, getCapabilities, deleteHost, setFavorite,
  authorizeSelfShell, authorizeSelfVnc, authorizeSelfRdp, authorizeSelfClaudeCode,
  getSelfShells, killSelfShell,
  createFolder, createSnippet, deleteSnippet,
  type RemoteHost, type RemoteFolder, type RemoteSnippet, type Capabilities, type SelfShell,
} from '@/components/remote/api'

export function RemoteLayout() {
  return (
    <RemoteSessionsProvider>
      <RemoteApp />
    </RemoteSessionsProvider>
  )
}

const KIND_ICON = { ssh: TerminalSquare, 'host-shell': ServerCog, vnc: Monitor, rdp: MonitorPlay, 'claude-code': Bot } as const

function RemoteApp() {
  const { sessions, activeId, open, close, focus } = useRemoteSessions()

  const [hosts, setHosts] = useState<RemoteHost[]>([])
  const [folders, setFolders] = useState<RemoteFolder[]>([])
  const [snippets, setSnippets] = useState<RemoteSnippet[]>([])
  const [caps, setCaps] = useState<Capabilities | null>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editHost, setEditHost] = useState<RemoteHost | null>(null)
  const [pinOpen, setPinOpen] = useState(false)
  const [serverProto, setServerProto] = useState<'shell' | 'vnc' | 'rdp' | 'claude-code'>('shell')
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  const [delTarget, setDelTarget] = useState<RemoteHost | null>(null)
  const [folderOpen, setFolderOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)

  const refreshHosts = useCallback(() => { void getHosts().then(setHosts).catch(() => {}) }, [])
  const refreshFolders = useCallback(() => { void getFolders().then(setFolders).catch(() => {}) }, [])
  const refreshSnippets = useCallback(() => { void getSnippets().then(setSnippets).catch(() => {}) }, [])

  useEffect(() => {
    void getCapabilities().then(setCaps).catch(() => {})
    refreshHosts(); refreshFolders(); refreshSnippets()
  }, [refreshHosts, refreshFolders, refreshSnippets])

  const onConnect = (host: RemoteHost, kind: 'ssh' | 'vnc' | 'rdp') =>
    open({ kind, hostId: host.id, title: host.label, subtitle: host.hostname })

  const onServerConnect = (proto: 'shell' | 'vnc' | 'rdp' | 'claude-code') => { setServerProto(proto); setPinOpen(true) }

  // Multiple independent server shells: each tab attaches to its own persistent
  // sidecar session (slot). Opening the same slot twice just focuses the tab.
  const openShellTab = (token: string, slot: string) => {
    const existing = sessions.find((s) => s.kind === 'host-shell' && (s.shellSlot ?? 'default') === slot)
    if (existing) { focus(existing.id); return }
    open({ kind: 'host-shell', hostShellToken: token, shellSlot: slot, title: slot === 'default' ? 'Shell' : `Shell ${slot.slice(0, 4)}`, subtitle: 'this server' })
  }
  const [shellPicker, setShellPicker] = useState<{ token: string; shells: SelfShell[] } | null>(null)
  const newShellSlot = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)

  const connectServer = async (pin: string) => {
    try {
      if (serverProto === 'shell') {
        const token = await authorizeSelfShell(pin)
        // Live detached sessions on the server? Offer to reattach before minting
        // a fresh one; sessions survive disconnects/restarts by design.
        const shells = await getSelfShells().catch(() => [] as SelfShell[])
        if (shells.length > 0) setShellPicker({ token, shells })
        else openShellTab(token, newShellSlot())
      } else if (serverProto === 'vnc') {
        const { token, password } = await authorizeSelfVnc(pin)
        open({ kind: 'vnc', selfToken: token, selfVncPassword: password, title: 'This server', subtitle: 'VNC desktop' })
      } else if (serverProto === 'rdp') {
        const { token, username, password, security } = await authorizeSelfRdp(pin)
        open({ kind: 'rdp', selfToken: token, selfRdp: { username, password, security }, title: 'This server', subtitle: 'RDP desktop' })
      } else {
        await authorizeSelfClaudeCode(pin)
        open({ kind: 'claude-code', title: 'Claude Code', subtitle: 'this server' })
      }
    } catch (e) { toast.error(`Authorization failed: ${e instanceof Error ? e.message : e}`) }
  }

  const onToggleFav = async (host: RemoteHost) => {
    try { await setFavorite(host.id, !host.favorite); refreshHosts() } catch { toast.error('Failed') }
  }
  const doDelete = async (host: RemoteHost) => {
    try { await deleteHost(host.id); toast.success('Deleted'); refreshHosts() } catch (e) { toast.error(`Delete failed: ${e instanceof Error ? e.message : e}`) }
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <ConnectionSidebar
        hosts={hosts} folders={folders} capabilities={caps}
        onConnect={onConnect}
        onServerConnect={onServerConnect}
        onClaudeCode={() => onServerConnect('claude-code')}
        onServerSettings={() => setServerSettingsOpen(true)}
        onEdit={(h) => { setEditHost(h); setEditorOpen(true) }}
        onDelete={setDelTarget}
        onToggleFav={onToggleFav}
        onAddMachine={() => { setEditHost(null); setEditorOpen(true) }}
        onAddFolder={() => setFolderOpen(true)}
        onManageSnippets={() => setSnippetsOpen(true)}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {/* Tab bar */}
        {sessions.length > 0 && (
          <div className="flex items-center gap-0.5 overflow-x-auto border-b bg-muted/30 px-1.5 py-1">
            {sessions.map((s) => {
              const Icon = KIND_ICON[s.kind]
              const active = s.id === activeId
              return (
                <div key={s.id}
                  className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-control px-2.5 py-1 text-sm ${active ? 'bg-background shadow-sm' : 'text-muted-foreground hover:bg-background/60'}`}
                  onClick={() => focus(s.id)}>
                  <Icon className="size-3.5" />
                  <span className="max-w-40 truncate">{s.title}</span>
                  <button onClick={(e) => { e.stopPropagation(); close(s.id) }} className="opacity-50 hover:opacity-100"><X className="size-3.5" /></button>
                </div>
              )
            })}
          </div>
        )}

        {/* Session panes, kept mounted so sessions survive tab switches */}
        <div className="relative min-h-0 flex-1">
          {sessions.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <TerminalSquare className="size-10 opacity-40" />
              <div>
                <p className="text-sm">Pick a machine on the left to open a session.</p>
                <p className="text-xs">SSH terminals, VNC and RDP desktops, and file transfer.</p>
              </div>
            </div>
          )}
          {/* Hide inactive panes with `visibility`, never `display:none`: a display:none pane
              collapses to 0x0, which makes noVNC's scaleViewport observer compute a zero scale
              and blank the canvas grey (it never repaints on the way back). `invisible` keeps the
              pane's real size, so the desktop is intact when you switch tabs back. */}
          {sessions.map((s) => {
            const active = s.id === activeId
            return (
              <div key={s.id} className={`absolute inset-0 ${active ? '' : 'invisible'}`} aria-hidden={!active}>
                <SessionPane session={s} host={hosts.find((h) => h.id === s.hostId)} snippets={snippets} fontSize={13} active={active} />
              </div>
            )
          })}
        </div>
      </div>

      <MachineEditorDialog
        open={editorOpen} host={editHost} folders={folders} isAdmin={!!caps?.isAdmin}
        onClose={() => setEditorOpen(false)} onSaved={refreshHosts}
      />
      <PinDialog open={pinOpen} onOpenChange={setPinOpen}
        title={serverProto === 'shell' ? 'Confirm host shell'
          : serverProto === 'claude-code' ? 'Confirm Claude Code'
          : `Connect to this server (${serverProto.toUpperCase()})`}
        description={serverProto === 'shell'
          ? 'Opening a shell on this server with full app-user access. Enter your admin PIN.'
          : serverProto === 'claude-code'
            ? 'Opening the Claude Code CLI on this server. Enter your admin PIN.'
            : `Opening a ${serverProto.toUpperCase()} desktop session to this server. Enter your admin PIN.`}
        onSubmit={connectServer} />
      <ServerDesktopDialog open={serverSettingsOpen} onClose={() => setServerSettingsOpen(false)} />
      <ShellPickerDialog
        picker={shellPicker}
        onClose={() => setShellPicker(null)}
        onReattach={(slot) => { if (shellPicker) { openShellTab(shellPicker.token, slot); setShellPicker(null) } }}
        onNew={() => { if (shellPicker) { openShellTab(shellPicker.token, newShellSlot()); setShellPicker(null) } }}
        onKill={async (slot) => {
          try {
            await killSelfShell(slot)
            setShellPicker((cur) => (cur ? { ...cur, shells: cur.shells.filter((s) => s.slot !== slot) } : cur))
          } catch { toast.error('Failed to end session') }
        }}
      />
      <ConfirmDialog open={!!delTarget} onOpenChange={(o) => { if (!o) setDelTarget(null) }}
        title="Delete machine?" description={delTarget ? `${delTarget.label} (${delTarget.hostname}) and its stored credentials will be removed.` : ''}
        confirmLabel="Delete" destructive onConfirm={() => delTarget && doDelete(delTarget)} />
      <FolderDialog open={folderOpen} isAdmin={!!caps?.isAdmin} onClose={() => setFolderOpen(false)} onSaved={refreshFolders} />
      <SnippetsDialog open={snippetsOpen} isAdmin={!!caps?.isAdmin} snippets={snippets} onClose={() => setSnippetsOpen(false)} onChanged={refreshSnippets} />
    </div>
  )
}

// Reattach picker: shown when the server already has live shell sessions for this
// admin. Sessions keep running when a tab closes or the connection drops, so this
// is how you get back to them (or explicitly end one).
function ShellPickerDialog({ picker, onClose, onReattach, onNew, onKill }: {
  picker: { token: string; shells: SelfShell[] } | null
  onClose: () => void
  onReattach: (slot: string) => void
  onNew: () => void
  onKill: (slot: string) => void | Promise<void>
}) {
  return (
    <Dialog open={!!picker} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Server shells</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            These shell sessions are still running on the server. Reattach to pick one up where you left off, or start a fresh one.
          </p>
          <div className="divide-y rounded-card border">
            {(picker?.shells ?? []).map((s) => (
              <div key={s.slot} className="flex items-center gap-2 px-3 py-2 text-sm">
                <ServerCog className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.slot === 'default' ? 'Shell' : `Shell ${s.slot.slice(0, 4)}`}</div>
                  <div className="text-xs text-muted-foreground">{s.clients > 0 ? `attached in ${s.clients} place${s.clients === 1 ? '' : 's'}` : 'running detached'}</div>
                </div>
                <Button size="sm" onClick={() => onReattach(s.slot)}>Reattach</Button>
                <Button variant="ghost" size="icon-sm" title="End this session" aria-label="End this session" onClick={() => void onKill(s.slot)}>
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
            ))}
            {(picker?.shells.length ?? 0) === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">No live sessions left.</div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onNew}><Plus className="mr-1.5 size-4" />New shell</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FolderDialog({ open, isAdmin, onClose, onSaved }: { open: boolean; isAdmin: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  useEffect(() => { if (open) { setName(''); setShared(false) } }, [open])
  const save = async () => {
    if (!name.trim()) return
    try { await createFolder({ name: name.trim(), shared }); onSaved(); onClose() } catch (e) { toast.error(`Failed: ${e instanceof Error ? e.message : e}`) }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>New folder</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-2"><Label>Name</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save() }} /></div>
          {isAdmin && <div className="flex items-center justify-between"><Label>Shared with everyone</Label><Switch checked={shared} onCheckedChange={setShared} /></div>}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={save}>Create</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SnippetsDialog({ open, isAdmin, snippets, onClose, onChanged }: { open: boolean; isAdmin: boolean; snippets: RemoteSnippet[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [shared, setShared] = useState(false)
  const add = async () => {
    if (!name.trim() || !command.trim()) return
    try { await createSnippet({ name: name.trim(), command, shared }); setName(''); setCommand(''); onChanged() } catch (e) { toast.error(`Failed: ${e instanceof Error ? e.message : e}`) }
  }
  const remove = async (id: string) => { try { await deleteSnippet(id); onChanged() } catch { toast.error('Failed') } }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Snippets</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {snippets.length > 0 && (
            <div className="divide-y rounded-card border">
              {snippets.map((s) => (
                <div key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1"><div className="truncate font-medium">{s.name}</div><div className="truncate font-mono text-xs text-muted-foreground">{s.command}</div></div>
                  {s.shared && <span className="text-[10px] text-muted-foreground">shared</span>}
                  {s.canManage && <Button variant="ghost" size="icon-sm" onClick={() => remove(s.id)}><Trash2 className="size-4 text-destructive" /></Button>}
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2 rounded-card border p-3">
            <div className="grid gap-2"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Restart nginx" /></div>
            {/* design-ok(mobile-input-zoom): command field is monospace-small by design; desktop-oriented admin/power UI. */}
            <div className="grid gap-2"><Label>Command</Label><Textarea className="min-h-16 font-mono text-xs" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="sudo systemctl restart nginx" /></div>
            {isAdmin && <div className="flex items-center justify-between"><Label>Shared with everyone</Label><Switch checked={shared} onCheckedChange={setShared} /></div>}
            <Button size="sm" onClick={add}><Plus className="mr-1.5 size-4" />Add snippet</Button>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
