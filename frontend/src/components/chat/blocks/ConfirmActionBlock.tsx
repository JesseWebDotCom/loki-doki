import { useEffect, useState } from 'react'
import { Check, ShieldQuestion, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCompanionEngine } from '@/components/shell/CompanionEngineContext'
import type { ConfirmActionBlockData } from './types'

// Approve/decline card for a staged companion action (confirm_action directive)
// inside a chat reply. Derived client-side from the directive (ChatContext), so
// like all blocks it is ephemeral: it disappears on reload, which matches the
// 60s server-side TTL of the staged action itself.
//
// Memo contract (BlockRenderer): `data` is append-only and never mutated; all
// UI state (pending/approved/declined/expired) lives locally here.

type Resolution = 'pending' | 'approved' | 'declined' | 'expired'

export function ConfirmActionBlock({ data }: { data: ConfirmActionBlockData }) {
  const engine = useCompanionEngine()
  const [resolution, setResolution] = useState<Resolution>(
    Date.now() >= data.expiresAt ? 'expired' : 'pending',
  )

  useEffect(() => {
    if (resolution !== 'pending') return
    const t = setTimeout(() => setResolution((r) => (r === 'pending' ? 'expired' : r)), Math.max(0, data.expiresAt - Date.now()))
    return () => clearTimeout(t)
  }, [resolution, data.expiresAt])

  // Resolution re-enters the turn with canonical text; the confirm_pending tool
  // executes (or cancels) the staged action and the outcome streams as the next
  // reply bubble (MusicPlayBlock precedent for blocks driving global contexts).
  const resolve = (approve: boolean) => {
    setResolution(approve ? 'approved' : 'declined')
    engine.handleSend(approve ? 'Yes' : 'No')
  }

  return (
    <div className="mb-2 flex max-w-md items-center gap-3 rounded-card border border-border bg-card px-3 py-2.5">
      <ShieldQuestion className="size-5 shrink-0 text-brand" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground" title={data.summary}>{data.summary}</p>
        {resolution === 'pending' ? (
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={() => resolve(true)} className="h-7 rounded-full bg-brand text-brand-foreground hover:bg-brand/85">
              <Check className="size-3.5" />
              {data.approveLabel}
            </Button>
            <Button size="sm" variant="outline" onClick={() => resolve(false)} className="h-7 rounded-full">
              <X className="size-3.5" />
              {data.declineLabel}
            </Button>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {resolution === 'approved' ? 'Approved' : resolution === 'declined' ? 'Declined' : 'Expired, ask again if you still want this'}
          </p>
        )}
      </div>
    </div>
  )
}
