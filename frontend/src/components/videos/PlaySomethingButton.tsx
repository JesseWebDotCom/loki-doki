import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shuffle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { playSomething } from '@/lib/videos/api'

// "Play Something": Netflix's decision-fatigue killer. One tap picks an unwatched video
// from what this person already follows (server-side, policy-filtered) and opens it.
// Especially useful on approved-only kid profiles, where browsing is deliberately absent.
export function PlaySomethingButton({ className }: { className?: string }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  async function go() {
    if (busy) return
    setBusy(true)
    try {
      const { item } = await playSomething()
      if (!item) { toast.info('Nothing to play yet. Subscribe to a few creators first.'); return }
      navigate(`/videos/${item.source}/watch/${encodeURIComponent(item.id)}`)
    } catch {
      toast.error('Could not pick a video')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="secondary" onClick={() => void go()} disabled={busy} className={className}>
      {busy ? <Spinner className="size-4" /> : <Shuffle className="size-4" />} Play something
    </Button>
  )
}
