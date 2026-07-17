import { Hourglass } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useFamilyAudio, formatRemaining } from '@/hooks/useFamilyAudio'

// Family audio: the kid-visible remaining-time pill shown unobtrusively in the players.
// Renders nothing for profiles without a daily audio budget.
export function FamilyRemainingChip({ className }: { className?: string }) {
  const { data } = useFamilyAudio()
  if (!data || data.remainingMinutes == null) return null
  const low = data.remainingMinutes <= 5
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums',
        low ? 'bg-destructive/15 text-destructive' : 'bg-foreground/8 text-muted-foreground',
        className,
      )}
      title="Audio time left today"
    >
      <Hourglass className="size-3" />
      {formatRemaining(data.remainingMinutes)}
    </span>
  )
}
