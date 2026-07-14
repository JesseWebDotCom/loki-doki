import { useMemo, useState } from 'react'
import { Server, Plus, Search, Star, MoreVertical, Pencil, Trash2, TerminalSquare, Monitor, MonitorPlay, Folder, ChevronRight, ChevronDown, ShieldAlert, Zap, FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { RemoteHost, RemoteFolder, Capabilities } from './api'

type Proto = 'ssh' | 'vnc' | 'rdp'
const defaultProto = (h: RemoteHost): Proto | null => (h.ssh ? 'ssh' : h.vnc ? 'vnc' : h.rdp ? 'rdp' : null)

export function ConnectionSidebar({ hosts, folders, capabilities, onConnect, onHostShell, onEdit, onDelete, onToggleFav, onAddMachine, onAddFolder, onManageSnippets }: {
  hosts: RemoteHost[]
  folders: RemoteFolder[]
  capabilities: Capabilities | null
  onConnect: (host: RemoteHost, kind: Proto) => void
  onHostShell: () => void
  onEdit: (host: RemoteHost) => void
  onDelete: (host: RemoteHost) => void
  onToggleFav: (host: RemoteHost) => void
  onAddMachine: () => void
  onAddFolder: () => void
  onManageSnippets: () => void
}) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleFolder = (id: string) => setCollapsed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? hosts.filter((h) => h.label.toLowerCase().includes(t) || h.hostname.toLowerCase().includes(t)) : hosts
  }, [hosts, q])

  const favorites = filtered.filter((h) => h.favorite)
  const byFolder = (fid: string) => filtered.filter((h) => h.folderId === fid)
  const ungrouped = filtered.filter((h) => !h.folderId)

  return (
    <div className="flex w-72 shrink-0 flex-col border-r bg-background">
      <div className="flex items-center gap-1 px-3 py-2.5">
        <TerminalSquare className="size-5 text-primary" />
        <span className="font-semibold">Remote</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" title="Add machine" onClick={onAddMachine}><Plus className="size-4" /></Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm"><MoreVertical className="size-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onAddFolder}><FolderPlus className="mr-2 size-4" />New folder</DropdownMenuItem>
              <DropdownMenuItem onClick={onManageSnippets}><Zap className="mr-2 size-4" />Snippets</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search machines" className="h-8 pl-8" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {capabilities?.isAdmin && (
          // design-ok(hand-styled-button): sidebar list-row action (like the host rows), not a form button.
          <button onClick={onHostShell} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60">
            <ShieldAlert className="size-4 text-warning" />
            <span className="flex-1">This server (shell)</span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">admin</span>
          </button>
        )}

        {favorites.length > 0 && (
          <Section label="Favorites">
            {favorites.map((h) => <HostRow key={`f-${h.id}`} host={h} onConnect={onConnect} onEdit={onEdit} onDelete={onDelete} onToggleFav={onToggleFav} />)}
          </Section>
        )}

        {folders.map((fo) => {
          const rows = byFolder(fo.id)
          if (q && rows.length === 0) return null
          const open = !collapsed.has(fo.id)
          return (
            <div key={fo.id}>
              <button onClick={() => toggleFolder(fo.id)} className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/40">
                {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                <Folder className="size-3.5" />
                <span className="flex-1 truncate">{fo.name}</span>
                {fo.shared && <span className="text-[10px]">shared</span>}
              </button>
              {open && rows.map((h) => <HostRow key={h.id} host={h} indent onConnect={onConnect} onEdit={onEdit} onDelete={onDelete} onToggleFav={onToggleFav} />)}
            </div>
          )
        })}

        {ungrouped.length > 0 && (
          <Section label={folders.length > 0 ? 'Ungrouped' : 'Machines'}>
            {ungrouped.map((h) => <HostRow key={h.id} host={h} onConnect={onConnect} onEdit={onEdit} onDelete={onDelete} onToggleFav={onToggleFav} />)}
          </Section>
        )}

        {hosts.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
            <Server className="size-8 opacity-40" />
            <p>No machines yet.</p>
            <Button size="sm" variant="outline" onClick={onAddMachine}><Plus className="mr-1.5 size-4" />Add machine</Button>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-1">
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

function HostRow({ host, indent, onConnect, onEdit, onDelete, onToggleFav }: {
  host: RemoteHost; indent?: boolean
  onConnect: (h: RemoteHost, k: Proto) => void
  onEdit: (h: RemoteHost) => void
  onDelete: (h: RemoteHost) => void
  onToggleFav: (h: RemoteHost) => void
}) {
  const def = defaultProto(host)
  return (
    <div className={`group flex items-center gap-2 py-1.5 pr-2 text-sm hover:bg-muted/60 ${indent ? 'pl-7' : 'pl-3'}`}>
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => def && onConnect(host, def)} disabled={!def}>
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{host.label}</span>
          <span className="block truncate text-xs text-muted-foreground">{host.hostname}</span>
        </span>
        {host.favorite && <Star className="size-3.5 shrink-0 fill-current text-warning" />}
        {host.shared && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">shared</span>}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100"><MoreVertical className="size-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {host.ssh && <DropdownMenuItem onClick={() => onConnect(host, 'ssh')}><TerminalSquare className="mr-2 size-4" />SSH terminal</DropdownMenuItem>}
          {host.vnc && <DropdownMenuItem onClick={() => onConnect(host, 'vnc')}><Monitor className="mr-2 size-4" />VNC</DropdownMenuItem>}
          {host.rdp && <DropdownMenuItem onClick={() => onConnect(host, 'rdp')}><MonitorPlay className="mr-2 size-4" />RDP</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onToggleFav(host)}><Star className="mr-2 size-4" />{host.favorite ? 'Unfavorite' : 'Favorite'}</DropdownMenuItem>
          {host.canManage && <DropdownMenuItem onClick={() => onEdit(host)}><Pencil className="mr-2 size-4" />Edit</DropdownMenuItem>}
          {host.canManage && <DropdownMenuItem onClick={() => onDelete(host)}><Trash2 className="mr-2 size-4 text-destructive" />Delete</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
