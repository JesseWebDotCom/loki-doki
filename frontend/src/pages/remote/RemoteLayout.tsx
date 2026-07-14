import { useCallback, useEffect, useState } from 'react'
import { TerminalSquare, Monitor, MonitorPlay, X, ServerCog, Plus, Trash2 } from 'lucide-react'
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
import {
  getHosts, getFolders, getSnippets, getCapabilities, deleteHost, setFavorite, authorizeHostShell,
  createFolder, createSnippet, deleteSnippet,
  type RemoteHost, type RemoteFolder, type RemoteSnippet, type Capabilities,
} from '@/components/remote/api'

export function RemoteLayout() {
  return (
    <RemoteSessionsProvider>
      <RemoteApp />
    </RemoteSessionsProvider>
  )
}

const KIND_ICON = { ssh: TerminalSquare, 'host-shell': ServerCog, vnc: Monitor, rdp: MonitorPlay } as const

function RemoteApp() {
  const { sessions, activeId, open, close, focus } = useRemoteSessions()

  const [hosts, setHosts] = useState<RemoteHost[]>([])
  const [folders, setFolders] = useState<RemoteFolder[]>([])
  const [snippets, setSnippets] = useState<RemoteSnippet[]>([])
  const [caps, setCaps] = useState<Capabilities | null>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editHost, setEditHost] = useState<RemoteHost | null>(null)
  const [pinOpen, setPinOpen] = useState(false)
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

  const onHostShell = () => setPinOpen(true)
  const connectHostShell = async (pin: string) => {
    try {
      const token = await authorizeHostShell(pin)
      open({ kind: 'host-shell', hostShellToken: token, title: 'This server', subtitle: 'host shell' })
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
        onHostShell={onHostShell}
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
          {sessions.map((s) => (
            <div key={s.id} className="absolute inset-0" style={{ display: s.id === activeId ? 'block' : 'none' }}>
              <SessionPane session={s} host={hosts.find((h) => h.id === s.hostId)} snippets={snippets} fontSize={13} />
            </div>
          ))}
        </div>
      </div>

      <MachineEditorDialog
        open={editorOpen} host={editHost} folders={folders} isAdmin={!!caps?.isAdmin}
        onClose={() => setEditorOpen(false)} onSaved={refreshHosts}
      />
      <PinDialog open={pinOpen} onOpenChange={setPinOpen} title="Confirm host shell"
        description="Opening a shell on this server with full app-user access. Enter your admin PIN." onSubmit={connectHostShell} />
      <ConfirmDialog open={!!delTarget} onOpenChange={(o) => { if (!o) setDelTarget(null) }}
        title="Delete machine?" description={delTarget ? `${delTarget.label} (${delTarget.hostname}) and its stored credentials will be removed.` : ''}
        confirmLabel="Delete" destructive onConfirm={() => delTarget && doDelete(delTarget)} />
      <FolderDialog open={folderOpen} isAdmin={!!caps?.isAdmin} onClose={() => setFolderOpen(false)} onSaved={refreshFolders} />
      <SnippetsDialog open={snippetsOpen} isAdmin={!!caps?.isAdmin} snippets={snippets} onClose={() => setSnippetsOpen(false)} onChanged={refreshSnippets} />
    </div>
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
