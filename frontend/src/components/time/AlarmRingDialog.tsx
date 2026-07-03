// Global "ringing" dialog. Mounted once near the app root; it surfaces whenever
// the TimeAlarmContext fires an alarm or timer, no matter the current page. The
// sound + companion announcement are driven by the context; this is just the
// Snooze/Dismiss confirmation UI. Any close (button, Escape, backdrop) dismisses.

import { BellRing } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTimeApp } from '@/context/TimeAlarmContext'

export function AlarmRingDialog() {
  const { ringing, snoozeRing, dismissRing } = useTimeApp()
  const open = ringing !== null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) dismissRing() }}>
      <DialogContent className="sm:max-w-sm">
        <div className="flex flex-col items-center gap-4 pt-2 text-center">
          <span className="relative flex size-20 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-brand/30" />
            <span className="relative flex size-20 items-center justify-center rounded-full bg-brand/15 text-brand">
              {/* design-ok(adhoc-pulse): live ringing indicator */}
              <BellRing className="size-9 animate-pulse" />
            </span>
          </span>
          <div className="space-y-1">
            <DialogTitle className="text-2xl font-bold tracking-tight">
              {ringing?.label || (ringing?.kind === 'timer' ? 'Timer' : 'Alarm')}
            </DialogTitle>
            <DialogDescription className="text-base">
              {ringing?.kind === 'timer' ? "Time's up" : ringing?.subtitle}
            </DialogDescription>
          </div>
          <div className="mt-2 grid w-full grid-cols-2 gap-3">
            <Button variant="outline" size="lg" onClick={() => snoozeRing()}>
              Snooze
            </Button>
            <Button size="lg" onClick={() => dismissRing()}>
              Dismiss
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
