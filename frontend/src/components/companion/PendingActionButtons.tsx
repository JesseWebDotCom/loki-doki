import { memo } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import type { PendingCompanionAction } from '@/components/shell/CompanionEngineContext'

// Approve/decline row for a staged companion action (confirm_action directive),
// rendered under the caption wherever the offer appears: dock speech bubble,
// desktop island, mobile sheet. Clicking re-enters the turn with a canonical
// 'Yes'/'No' via the engine, so the outcome streams (and speaks) like any reply.

export const PendingActionButtons = memo(function PendingActionButtons({ action, onApprove, onDecline, tone = 'default', className }: {
  action: PendingCompanionAction
  onApprove: () => void
  onDecline: () => void
  /** 'dark' adapts hover surfaces for the black island capsule. */
  tone?: 'default' | 'dark'
  className?: string
}) {
  return (
    <div className={cn('mt-2 flex items-center gap-2', className)}>
      <Button
        size="sm"
        onClick={onApprove}
        className={cn('h-8 flex-1 rounded-full bg-brand text-brand-foreground hover:bg-brand/85', tone === 'dark' && 'shadow-lg')}
      >
        <Check className="size-3.5" />
        {action.approveLabel}
      </Button>
      <Button
        size="sm"
        variant="destructive"
        onClick={onDecline}
        className="h-8 flex-1 rounded-full"
      >
        <X className="size-3.5" />
        {action.declineLabel}
      </Button>
    </div>
  )
})
