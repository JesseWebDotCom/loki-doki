import { useCallback, useEffect, useRef, useState } from 'react'
import { Share2, Upload, Inbox, Monitor, Smartphone, Download, Copy, X, Send, RefreshCw } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import {
  listDropDevices, getInbox, sendFile, sendText, downloadDrop, dismissDrop, formatBytes,
  type DropDevice, type DropPreview,
} from '@/lib/drop'

function deviceIcon(label: string) {
  return /iOS|Android/.test(label) ? Smartphone : Monitor
}

export function DropPage() {
  const [devices, setDevices] = useState<DropDevice[]>([])
  const [target, setTarget] = useState<string | null>(null) // null = all my devices
  const [inbox, setInbox] = useState<DropPreview[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    const [devs, inb] = await Promise.all([listDropDevices(), getInbox()])
    setDevices(devs)
    setInbox(inb)
    // If the chosen target went offline, fall back to "all my devices".
    setTarget((t) => (t && !devs.some((d) => d.deviceId === t) ? null : t))
  }, [])

  useEffect(() => {
    void refresh()
    const iv = setInterval(() => void refresh(), 8_000)
    const onEvt = () => void refresh()
    window.addEventListener('drop:incoming', onEvt)
    window.addEventListener('drop:claimed', onEvt)
    return () => {
      clearInterval(iv)
      window.removeEventListener('drop:incoming', onEvt)
      window.removeEventListener('drop:claimed', onEvt)
    }
  }, [refresh])

  const doSendFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    setBusy(true)
    let ok = 0
    for (const f of list) {
      const res = await sendFile(f, target)
      if (res.ok) ok++
      else if (res.status === 409) toast.error('That device went offline')
      else toast.error(`Couldn't send ${f.name}`)
    }
    setBusy(false)
    if (ok) toast.success(ok === 1 ? 'Sent' : `Sent ${ok} files`)
  }, [target])

  const doSendText = useCallback(async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    const res = await sendText(body, target)
    setBusy(false)
    if (res.ok) { setText(''); toast.success('Sent') }
    else if (res.status === 409) toast.error('That device went offline')
    else toast.error("Couldn't send")
  }, [text, target])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files?.length) void doSendFiles(e.dataTransfer.files)
  }, [doSendFiles])

  const noDevices = devices.length === 0

  return (
    <PageShell>
      <PageContainer width="default">
        <PageHeader subtitle="Send files and links between your own devices" />

        {noDevices && inbox.length === 0 ? (
          <EmptyAppState
            icon={Share2}
            title="Drop files between your devices"
            tagline="Open this app on another device signed in as you (phone, tablet, or laptop) and send files or links back and forth instantly, straight through your home server."
            features={[
              { icon: Upload, title: 'Any file', desc: 'Photos, PDFs, archives, up to 2 GB per drop.' },
              { icon: Send, title: 'Links & text', desc: 'Fire a URL or snippet to another screen in a tap.' },
              { icon: Inbox, title: 'Land anywhere', desc: 'Incoming drops pop up wherever you are in the app.' },
              { icon: Monitor, title: 'Your devices only', desc: 'Everything stays inside your household, never the cloud.' },
            ]}
            footnote="Waiting for another device to come online…"
          />
        ) : (
          <div className="mt-6 flex flex-col gap-8">
            {/* Target picker */}
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-overline text-muted-foreground">Send to</h2>
                <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                  <RefreshCw className="size-4" /> Refresh
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <TargetChip
                  active={target === null}
                  onClick={() => setTarget(null)}
                  icon={Share2}
                  label="All my devices"
                />
                {devices.map((d) => {
                  const Icon = deviceIcon(d.label)
                  return (
                    <TargetChip
                      key={d.deviceId}
                      active={target === d.deviceId}
                      onClick={() => setTarget(d.deviceId)}
                      icon={Icon}
                      label={d.label}
                    />
                  )
                })}
                {noDevices && (
                  <span className="text-sm text-muted-foreground">No other devices online. Sending will queue for pickup.</span>
                )}
              </div>
            </section>

            {/* Drop zone + text */}
            <section className="grid gap-4 md:grid-cols-2">
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
                className={cn(
                  'flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed p-8 text-center transition-colors',
                  dragging ? 'border-brand bg-brand/5' : 'border-border hover:border-muted-foreground/40',
                )}
              >
                <Upload className="size-8 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">Drop files here or click to choose</p>
                <p className="mt-1 text-xs text-muted-foreground">Up to 2 GB per file</p>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => { if (e.target.files) { void doSendFiles(e.target.files); e.target.value = '' } }}
                />
              </div>

              <div className="flex flex-col gap-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste a link or type a message…"
                  className="min-h-[7rem] flex-1 resize-none rounded-card border border-border bg-background p-3 text-sm outline-none focus:border-brand"
                />
                <Button onClick={() => void doSendText()} disabled={busy || !text.trim()}>
                  <Send className="size-4" /> Send text
                </Button>
              </div>
            </section>

            {/* Inbox */}
            {inbox.length > 0 && (
              <section>
                <h2 className="mb-3 text-overline text-muted-foreground">Received</h2>
                <div className="flex flex-col gap-2">
                  {inbox.map((d) => (
                    <InboxRow key={d.id} d={d} onGone={() => setInbox((x) => x.filter((y) => y.id !== d.id))} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </PageContainer>
    </PageShell>
  )
}

function TargetChip({ active, onClick, icon: Icon, label }: {
  active: boolean; onClick: () => void; icon: typeof Share2; label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors',
        active ? 'border-brand bg-brand/10 text-brand' : 'border-border text-foreground hover:bg-secondary',
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
}

function InboxRow({ d, onGone }: { d: DropPreview; onGone: () => void }) {
  return (
    <Card variant="surface" className="flex items-center gap-3 p-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-muted/60">
        {d.kind === 'text' ? <Copy className="size-4" /> : <Download className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {d.kind === 'text' ? (d.body || 'Message') : (d.fileName || 'file')}
        </p>
        <p className="text-xs text-muted-foreground">
          from {d.senderLabel}{d.kind === 'file' && d.sizeBytes != null ? ` · ${formatBytes(d.sizeBytes)}` : ''}
        </p>
      </div>
      {d.kind === 'text' ? (
        <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard?.writeText(d.body || ''); void dismissDrop(d.id).then(onGone); toast.success('Copied') }}>
          <Copy className="size-4" /> Copy
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => downloadDrop(d)}>
          <Download className="size-4" /> Save
        </Button>
      )}
      <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={() => void dismissDrop(d.id).then(onGone)}>
        <X className="size-4" />
      </Button>
    </Card>
  )
}
