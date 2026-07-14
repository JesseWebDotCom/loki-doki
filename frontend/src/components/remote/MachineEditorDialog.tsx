import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { createHost, updateHost, type RemoteHost, type HostInput, type RemoteFolder } from './api'

interface FormState {
  label: string; hostname: string; shared: boolean; folderId: string
  sshOn: boolean; sshPort: string; sshUser: string; sshAuth: 'password' | 'key'; sshSecret: string
  vncOn: boolean; vncPort: string; vncSecret: string
  rdpOn: boolean; rdpPort: string; rdpUser: string; rdpSecurity: 'nla' | 'tls' | 'rdp'; rdpSecret: string
}

function initForm(h: RemoteHost | null): FormState {
  return {
    label: h?.label ?? '', hostname: h?.hostname ?? '', shared: h?.shared ?? false, folderId: h?.folderId ?? '',
    sshOn: !!h?.ssh, sshPort: String(h?.ssh?.port ?? 22), sshUser: h?.ssh?.user ?? '', sshAuth: h?.ssh?.auth ?? 'password', sshSecret: '',
    vncOn: !!h?.vnc, vncPort: String(h?.vnc?.port ?? 5900), vncSecret: '',
    rdpOn: !!h?.rdp, rdpPort: String(h?.rdp?.port ?? 3389), rdpUser: h?.rdp?.user ?? '', rdpSecurity: h?.rdp?.security ?? 'nla', rdpSecret: '',
  }
}

function toInput(f: FormState): HostInput {
  return {
    label: f.label.trim(), hostname: f.hostname.trim(), shared: f.shared, folderId: f.folderId || null,
    ssh: f.sshOn ? { port: Number(f.sshPort) || 22, user: f.sshUser.trim(), auth: f.sshAuth, ...(f.sshSecret ? { secret: f.sshSecret } : {}) } : null,
    vnc: f.vncOn ? { port: Number(f.vncPort) || 5900, ...(f.vncSecret ? { secret: f.vncSecret } : {}) } : null,
    rdp: f.rdpOn ? { port: Number(f.rdpPort) || 3389, user: f.rdpUser.trim(), security: f.rdpSecurity, ...(f.rdpSecret ? { secret: f.rdpSecret } : {}) } : null,
  }
}

const selectCls = 'h-9 rounded-control border border-input bg-transparent px-3 text-sm'

export function MachineEditorDialog({ open, host, folders, isAdmin, onClose, onSaved }: {
  open: boolean
  host: RemoteHost | null
  folders: RemoteFolder[]
  isAdmin: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(() => initForm(host))
  const [saving, setSaving] = useState(false)
  // Re-seed when the target host changes (dialog reused across add/edit).
  const [seed, setSeed] = useState<string>(host?.id ?? 'new')
  if (open && seed !== (host?.id ?? 'new')) { setSeed(host?.id ?? 'new'); setForm(initForm(host)) }

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  async function save() {
    if (!form.label.trim() || !form.hostname.trim()) { toast.error('Name and hostname are required'); return }
    setSaving(true)
    try {
      if (host) await updateHost(host.id, toInput(form))
      else await createHost(toInput(form))
      toast.success('Saved')
      onSaved()
      onClose()
    } catch (e) { toast.error(`Save failed: ${e instanceof Error ? e.message : e}`) }
    setSaving(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{host ? 'Edit machine' : 'Add machine'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2"><Label>Name</Label><Input value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="Office NAS" /></div>
          <div className="grid gap-2"><Label>Hostname or IP</Label><Input value={form.hostname} onChange={(e) => set({ hostname: e.target.value })} placeholder="192.168.1.20" /></div>
          <div className="grid gap-2"><Label>Folder</Label>
            <select className={selectCls} value={form.folderId} onChange={(e) => set({ folderId: e.target.value })}>
              <option value="">No folder</option>
              {folders.map((fo) => <option key={fo.id} value={fo.id}>{fo.shared ? '🌐 ' : ''}{fo.name}</option>)}
            </select>
          </div>
          {isAdmin && (
            <div className="flex items-center justify-between rounded-card border p-3">
              <div><div className="text-sm font-medium">Shared with everyone</div><div className="text-xs text-muted-foreground">Visible to all household users, using these stored credentials.</div></div>
              <Switch checked={form.shared} onCheckedChange={(v) => set({ shared: v })} />
            </div>
          )}

          <ProtoBlock title="SSH (terminal + files)" on={form.sshOn} onToggle={(v) => set({ sshOn: v })}>
            <NumberField label="Port" value={form.sshPort} onChange={(v) => set({ sshPort: v })} />
            <div className="grid gap-2"><Label>Username</Label><Input value={form.sshUser} onChange={(e) => set({ sshUser: e.target.value })} /></div>
            <div className="grid gap-2"><Label>Auth</Label>
              <select className={selectCls} value={form.sshAuth} onChange={(e) => set({ sshAuth: e.target.value as 'password' | 'key' })}>
                <option value="password">Password</option><option value="key">Private key</option>
              </select>
            </div>
            <SecretField label={form.sshAuth === 'key' ? 'Private key' : 'Password'} multiline={form.sshAuth === 'key'} has={!!host?.ssh?.hasSecret} value={form.sshSecret} onChange={(v) => set({ sshSecret: v })} />
          </ProtoBlock>

          <ProtoBlock title="VNC (remote desktop)" on={form.vncOn} onToggle={(v) => set({ vncOn: v })}>
            <NumberField label="Port" value={form.vncPort} onChange={(v) => set({ vncPort: v })} />
            <SecretField label="VNC password" has={!!host?.vnc?.hasSecret} value={form.vncSecret} onChange={(v) => set({ vncSecret: v })} />
          </ProtoBlock>

          <ProtoBlock title="RDP (remote desktop)" on={form.rdpOn} onToggle={(v) => set({ rdpOn: v })}>
            <NumberField label="Port" value={form.rdpPort} onChange={(v) => set({ rdpPort: v })} />
            <div className="grid gap-2"><Label>Username</Label><Input value={form.rdpUser} onChange={(e) => set({ rdpUser: e.target.value })} /></div>
            <div className="grid gap-2"><Label>Security</Label>
              <select className={selectCls} value={form.rdpSecurity} onChange={(e) => set({ rdpSecurity: e.target.value as 'nla' | 'tls' | 'rdp' })}>
                <option value="nla">NLA (recommended)</option><option value="tls">TLS</option><option value="rdp">RDP (legacy)</option>
              </select>
            </div>
            <SecretField label="Password" has={!!host?.rdp?.hasSecret} value={form.rdpSecret} onChange={(v) => set({ rdpSecret: v })} />
          </ProtoBlock>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProtoBlock({ title, on, onToggle, children }: { title: string; on: boolean; onToggle: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className="rounded-card border p-3">
      <div className="flex items-center justify-between"><span className="text-sm font-medium">{title}</span><Switch checked={on} onCheckedChange={onToggle} /></div>
      {on && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  )
}
function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <div className="grid gap-2"><Label>{label}</Label><Input type="number" value={value} onChange={(e) => onChange(e.target.value)} className="w-32" /></div>
}
function SecretField({ label, value, onChange, has, multiline }: { label: string; value: string; onChange: (v: string) => void; has?: boolean; multiline?: boolean }) {
  const ph = has ? 'Leave blank to keep current' : ''
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {/* design-ok(mobile-input-zoom): private-key paste field; monospace-small is intentional, desktop-oriented. */}
      {multiline
        ? <Textarea className="min-h-24 font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} placeholder={ph || '-----BEGIN OPENSSH PRIVATE KEY-----'} />
        : <Input type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={ph} />}
    </div>
  )
}
