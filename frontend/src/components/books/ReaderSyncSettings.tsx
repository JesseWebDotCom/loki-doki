// Per-user "Reading sync" settings: the OPDS catalog URL and KOReader sync URL to
// paste into any reader app (KOReader, Sutra, Panels), plus the Send-to-Kindle
// email address. All values come from /api/books/reader-sync.

import { useEffect, useState } from 'react'
import { Check, Copy, Mail, Rss, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { getReaderSync, setKindleEmail, type ReaderSyncInfo } from '@/lib/books/api'

function CopyRow({ label, icon: Icon, value, hint }: { label: string; icon: typeof Rss; value: string; hint: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { toast.error('Could not copy') }
  }
  return (
    <div className="rounded-card border border-border p-3">
      <p className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4" />{label}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      <div className="mt-2 flex gap-2">
        <Input readOnly value={value} className="font-mono text-[16px] md:text-[12px]" onFocus={(e) => e.currentTarget.select()} />
        <Button variant="outline" size="icon" onClick={() => void copy()} aria-label="Copy">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  )
}

export function ReaderSyncSettings() {
  const [info, setInfo] = useState<ReaderSyncInfo | null>(null)
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { void getReaderSync().then((i) => { setInfo(i); setEmail(i.kindleEmail ?? '') }) }, [])

  if (!info) return <div className="flex justify-center py-6"><Spinner /></div>

  // Absolute URLs so they work when pasted into a device on the same network.
  const origin = window.location.origin
  const opdsUrl = info.opdsPath ? `${origin}${info.opdsPath}` : '(unavailable)'
  const kosyncUrl = `${origin}${info.kosyncPath}`

  const saveEmail = async () => {
    setSaving(true)
    try {
      await setKindleEmail(email)
      setInfo({ ...info, kindleEmail: email })
      toast.success('Send-to-Kindle address saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Reading sync</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Read your library in any OPDS reader and keep your place across devices with KOReader.
        </p>
      </div>

      <CopyRow
        label="OPDS catalog URL" icon={Rss} value={opdsUrl}
        hint="Add this in a reader app (KOReader, Panels, Sutra) to browse and download your library. Keep it private: it grants access to your books."
      />
      <CopyRow
        label="KOReader sync URL" icon={Smartphone} value={kosyncUrl}
        hint="In KOReader: Cloud sync, Custom server. Register once, then your reading position syncs across devices."
      />

      <div className="rounded-card border border-border p-3">
        <p className="flex items-center gap-2 text-sm font-medium"><Mail className="size-4" />Send-to-Kindle email</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your Kindle/Kobo email-in address. Add your server's sender address to your device's approved-senders list first.
        </p>
        <div className="mt-2 flex gap-2">
          <Input type="email" value={email} placeholder="you@kindle.com" onChange={(e) => setEmail(e.target.value)} />
          <Button disabled={saving || !email.trim() || email === info.kindleEmail} onClick={() => void saveEmail()}>
            {saving ? <Spinner size="sm" className="mr-1.5" /> : null}Save
          </Button>
        </div>
      </div>
    </div>
  )
}
