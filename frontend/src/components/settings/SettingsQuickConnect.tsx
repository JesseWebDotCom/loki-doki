import { useEffect, useState } from 'react'
import { Tv } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { approveQuickConnect, listQuickConnects, type QuickConnectPending } from '@/lib/quickConnect'

// The phone's side of Quick Connect: type (or tap) the code a TV is showing, and that TV
// becomes signed in as you. Nobody should type a PIN with a remote.
export function SettingsQuickConnect() {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<QuickConnectPending[]>([])

  // Poll the waiting list: a TV that just asked shows up as a one-tap button.
  useEffect(() => {
    let stop = false
    const tick = async () => {
      const rows = await listQuickConnects().catch(() => [])
      if (!stop) setPending(rows)
    }
    void tick()
    const iv = setInterval(() => void tick(), 5000)
    return () => { stop = true; clearInterval(iv) }
  }, [])

  async function approve(value: string) {
    const c = value.trim().toUpperCase()
    if (!c || busy) return
    setBusy(true)
    try {
      await approveQuickConnect(c)
      toast.success('Signed that screen in')
      setCode('')
      setPending((p) => p.filter((x) => x.code !== c))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not approve that code')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium"><Tv className="size-3.5" /> Sign in a TV</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Open this app on a TV and it shows a code. Enter it here and that screen signs in
          as you, with no typing on the remote.
        </p>
      </div>

      {pending.length > 0 && (
        <div className="space-y-1.5">
          {pending.map((p) => (
            <button key={p.code} onClick={() => void approve(p.code)} disabled={busy}
              className="flex w-full items-center gap-3 rounded-card border border-border/60 px-3 py-2 text-left transition hover:border-brand/40 hover:bg-accent">
              <span className="font-mono text-base font-bold tracking-widest text-brand">{p.code}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{p.label}</span>
              <span className="shrink-0 text-xs font-semibold text-brand">Approve</span>
            </button>
          ))}
        </div>
      )}

      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void approve(code) }}>
        <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Enter the code" maxLength={6}
          className="h-9 font-mono tracking-widest" />
        <Button type="submit" size="sm" disabled={!code.trim() || busy} className="shrink-0">Approve</Button>
      </form>
    </Card>
  )
}
