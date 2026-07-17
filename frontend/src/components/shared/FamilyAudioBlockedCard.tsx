import { MoonStar, Hourglass } from 'lucide-react'
import { cn } from '@/lib/cn'
import { cardVariants } from '@/components/ui/card'
import { useFamilyAudio } from '@/hooks/useFamilyAudio'

// Family audio: the friendly full-state card players and hubs show when the profile's
// audio gate is closed (daily budget spent or quiet hours). Renders nothing while the
// gate is open, so pages can mount it unconditionally.
export function FamilyAudioBlockedCard({ className }: { className?: string }) {
  const { data } = useFamilyAudio()
  if (!data || data.allowed) return null
  const quiet = data.reason === 'quiet_hours'
  const Icon = quiet ? MoonStar : Hourglass
  return (
    <div className={cn(cardVariants({ variant: 'surface' }), 'flex items-center gap-4 p-5', className)}>
      <div className="flex size-12 shrink-0 items-center justify-center rounded-card bg-brand/15 text-brand">
        <Icon className="size-6" />
      </div>
      <div className="min-w-0">
        <p className="text-base font-bold tracking-tight">
          {quiet ? 'It is quiet hours right now' : 'Audio time is done for today'}
        </p>
        <p className="text-sm text-muted-foreground">
          {quiet
            ? 'Music and podcasts are asleep for the night. They will be back in the morning.'
            : 'Nice listening today! Your audio time refills tomorrow.'}
        </p>
      </div>
    </div>
  )
}
