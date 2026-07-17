import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tv } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { startQuickConnect, pollQuickConnect } from '@/lib/quickConnect'

// Quick Connect for TVs: show a code, poll, and let a phone do the actual signing in.
// Nobody should type a PIN with a remote. Jellyfin's Quick Connect flow, our login.
export function TvSignInPage() {
  const navigate = useNavigate()
  const [code, setCode] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [round, setRound] = useState(0)   // bumping this starts a fresh code

  // Ask for a code (one per round).
  useEffect(() => {
    let cancelled = false
    setCode(null)
    setExpired(false)
    void startQuickConnect('Living room TV')
      .then((r) => { if (!cancelled) setCode(r.code) })
      .catch(() => { if (!cancelled) setExpired(true) })
    return () => { cancelled = true }
  }, [round])

  // Poll until approved. The approving POST mints our session cookie, so a plain reload
  // into /tv is all that's left to do.
  useEffect(() => {
    if (!code) return
    let stop = false
    const tick = async () => {
      if (stop) return
      try {
        const { status } = await pollQuickConnect(code)
        if (stop) return
        if (status === 'approved') { navigate('/tv', { replace: true }); return }
        if (status === 'expired') { setExpired(true); return }
      } catch { /* transient; keep polling */ }
      setTimeout(() => void tick(), 2000)
    }
    const t = setTimeout(() => void tick(), 2000)
    return () => { stop = true; clearTimeout(t) }
  }, [code, navigate])

  return (
    // Always-dark and full-bleed: a TV is a dark room and has no theme toggle.
    // design-ok(raw-overlay): a TV surface has no mobile dock or app shell to stay clear
    // of, and this is the pre-login screen, so there is no shell to sit inside.
    <div data-theme="dark" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-black px-12 text-center text-foreground">
      <Tv className="size-12 text-brand" />
      <div className="space-y-2">
        {/* design-ok(raw-h1-in-pages): read across a room, not at arm's length. */}
        <h1 className="text-4xl font-bold tracking-tight">Sign in from your phone</h1>
        <p className="text-xl text-muted-foreground">
          Open Loki Doki on your phone, go to Settings, and enter this code.
        </p>
      </div>

      {expired ? (
        <div className="space-y-4">
          <p className="text-xl text-muted-foreground">That code expired.</p>
          <Button size="lg" onClick={() => setRound((r) => r + 1)}>Get a new code</Button>
        </div>
      ) : !code ? (
        <Spinner className="size-8" />
      ) : (
        <>
          <p className="font-mono text-7xl font-bold tracking-[0.2em] text-brand">{code}</p>
          <p className="flex items-center gap-2 text-base text-muted-foreground">
            <Spinner className="size-4" /> Waiting for approval…
          </p>
        </>
      )}
    </div>
  )
}
