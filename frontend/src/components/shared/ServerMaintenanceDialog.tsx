import { useEffect, useRef } from 'react'
import { CheckCircle2, XCircle, AlertCircle, PowerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import type { MaintenanceFlow, StepState } from '@/hooks/useServerMaintenance'

// The progress/waiting/error surface for the server maintenance state machine
// (useServerMaintenance). Shared by Admin > System > Server and the sidebar update
// badge so an update/restart/shutdown kicked off from either place looks identical.

function StepRow({ step }: { step: StepState }) {
  const Icon = step.status === 'ok' ? CheckCircle2
    : step.status === 'fail' ? XCircle
    : AlertCircle
  const color = step.status === 'ok' ? 'text-success'
    : step.status === 'fail' ? 'text-destructive'
    : 'text-muted-foreground'
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2.5 text-sm">
        {step.status === 'run'
          ? <Spinner className="size-4 shrink-0 text-brand" />
          : <Icon className={`size-4 shrink-0 ${color}`} />}
        <span className="font-medium">{step.label}</span>
      </div>
      {step.detail && <p className="ml-[26px] text-[11px] text-muted-foreground">{step.detail}</p>}
    </div>
  )
}

export interface ServerMaintenanceDialogProps {
  flow: MaintenanceFlow
  steps: StepState[]
  logLines: string[]
  error: string | null
  onDismissError: () => void
}

export function ServerMaintenanceDialog({ flow, steps, logLines, error, onDismissError }: ServerMaintenanceDialogProps) {
  const logRef = useRef<HTMLPreElement | null>(null)
  const busy = flow !== 'idle'

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logLines])

  return (
    <Dialog open={busy} onOpenChange={() => {}}>
      <DialogContent className="max-w-lg space-y-4 [&>button:last-child]:hidden">
        {(flow === 'updating' || flow === 'restarting' || flow === 'shuttingdown') && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5 text-base">
                <Spinner className="size-5 text-brand" />
                {flow === 'updating' ? 'Updating the server…'
                  : flow === 'restarting' ? 'Restarting the server…'
                  : 'Shutting down the server…'}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {flow === 'shuttingdown'
                  ? 'The server stops in a moment.'
                  : <>You can close this page; the {flow === 'updating' ? 'update' : 'restart'} continues on the server.</>}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {steps.map((s) => <StepRow key={s.key} step={s} />)}
            </div>
            {logLines.length > 0 && (
              <pre
                ref={logRef}
                className="max-h-40 overflow-y-auto rounded-control border border-border/60 bg-muted/30 p-2 text-[10px] leading-relaxed text-muted-foreground"
              >
                {logLines.join('\n')}
              </pre>
            )}
          </>
        )}

        {flow === 'waiting' && (
          <DialogHeader className="space-y-3 text-center sm:text-center">
            <Spinner className="mx-auto size-8 text-brand" />
            <DialogTitle className="text-base">Waiting for the server to come back…</DialogTitle>
            <DialogDescription className="text-xs">
              The page reloads automatically once the server is reachable again.
            </DialogDescription>
          </DialogHeader>
        )}

        {flow === 'off' && (
          <DialogHeader className="space-y-3 text-center sm:text-center">
            <PowerOff className="mx-auto size-8 text-muted-foreground" />
            <DialogTitle className="text-base">The server has shut down</DialogTitle>
            <DialogDescription className="text-xs">
              Launch it again on the server machine (run.ps1 or run.sh) to bring the app back.
              You can close this page.
            </DialogDescription>
          </DialogHeader>
        )}

        {flow === 'gone' && (
          <div className="space-y-3">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5 text-base">
                <XCircle className="size-5 text-destructive" />
                The server did not come back
              </DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground">
              It has been a few minutes without a response. Check the launcher console on the server
              machine (run.ps1 or run.sh) and start it again if needed.
            </p>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload page</Button>
            </div>
          </div>
        )}

        {flow === 'error' && (
          <div className="space-y-3">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2.5 text-base">
                <XCircle className="size-5 text-destructive" />
                {steps.some((s) => s.key === 'merge' && s.status === 'ok') ? 'Update failed after pulling code' : 'Operation failed'}
              </DialogTitle>
            </DialogHeader>
            <p className="text-xs text-muted-foreground">{error}</p>
            <div className="space-y-3">
              {steps.map((s) => <StepRow key={s.key} step={s} />)}
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={onDismissError}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
