import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { getSelfConfig, saveSelfConfig, type SelfDesktopInput } from './api'

// Admin-only settings for the "This server" VNC/RDP desktops. These connect over loopback
// (127.0.0.1) to a VNC server / Remote Desktop running on this host, so only the ports and
// credentials are configurable here. Passwords are write-only ("leave blank to keep").
export function ServerDesktopDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [host, setHost] = useState('127.0.0.1')
  const [vncPort, setVncPort] = useState('5900')
  const [vncPassword, setVncPassword] = useState('')
  const [vncHasSecret, setVncHasSecret] = useState(false)
  const [rdpPort, setRdpPort] = useState('3389')
  const [rdpUser, setRdpUser] = useState('')
  const [rdpPassword, setRdpPassword] = useState('')
  const [rdpHasSecret, setRdpHasSecret] = useState(false)
  const [rdpSecurity, setRdpSecurity] = useState<'nla' | 'tls' | 'rdp'>('nla')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    getSelfConfig()
      .then((c) => {
        setHost(c.host)
        setVncPort(String(c.vncPort)); setVncPassword(''); setVncHasSecret(c.vncHasSecret)
        setRdpPort(String(c.rdpPort)); setRdpUser(c.rdpUser); setRdpPassword(''); setRdpHasSecret(c.rdpHasSecret)
        setRdpSecurity(c.rdpSecurity)
      })
      .catch(() => toast.error('Could not load server desktop settings'))
      .finally(() => setLoading(false))
  }, [open])

  async function save() {
    setSaving(true)
    const body: SelfDesktopInput = {
      host: host.trim() || '127.0.0.1',
      vncPort: Number(vncPort) || 5900,
      rdpPort: Number(rdpPort) || 3389,
      rdpUser,
      rdpSecurity,
      ...(vncPassword ? { vncPassword } : {}),
      ...(rdpPassword ? { rdpPassword } : {}),
    }
    try {
      await saveSelfConfig(body)
      toast.success('Saved')
      onClose()
    } catch (e) { toast.error(`Save failed: ${e instanceof Error ? e.message : e}`) }
    setSaving(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Server desktop settings</DialogTitle></DialogHeader>
        {loading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              The address, ports, and password are auto-filled from a saved machine that points at
              this server. Change the address if the wrong one was picked (use 127.0.0.1 for a purely
              local desktop, or the LAN / Tailscale address your VNC or Remote Desktop server is bound
              to; a server listening only on a network interface will reject a loopback connection).
            </p>

            <div className="grid gap-2">
              <Label>Host / address</Label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
            </div>

            <div className="space-y-3 rounded-card border p-3">
              <div className="text-sm font-medium">VNC (remote desktop)</div>
              <NumberField label="Port" value={vncPort} onChange={setVncPort} />
              <SecretField label="VNC password" has={vncHasSecret} value={vncPassword} onChange={setVncPassword} />
            </div>

            <div className="space-y-3 rounded-card border p-3">
              <div className="text-sm font-medium">RDP (remote desktop)</div>
              <NumberField label="Port" value={rdpPort} onChange={setRdpPort} />
              <div className="grid gap-2"><Label>Username</Label><Input value={rdpUser} onChange={(e) => setRdpUser(e.target.value)} placeholder="Windows account" /></div>
              <div className="grid gap-2"><Label>Security</Label>
                <select className="h-9 rounded-control border border-input bg-transparent px-3 text-sm" value={rdpSecurity} onChange={(e) => setRdpSecurity(e.target.value as 'nla' | 'tls' | 'rdp')}>
                  <option value="nla">NLA (recommended)</option><option value="tls">TLS</option><option value="rdp">RDP (legacy)</option>
                </select>
              </div>
              <SecretField label="Password" has={rdpHasSecret} value={rdpPassword} onChange={setRdpPassword} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || loading}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <div className="grid gap-2"><Label>{label}</Label><Input type="number" value={value} onChange={(e) => onChange(e.target.value)} className="w-32" /></div>
}
function SecretField({ label, value, onChange, has }: { label: string; value: string; onChange: (v: string) => void; has?: boolean }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Input type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={has ? 'Leave blank to keep current' : ''} />
    </div>
  )
}
