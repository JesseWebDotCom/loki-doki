import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DeviceArt } from '@/components/admin/DeviceArt'
import { resolveDeviceModel, deviceModelName, deviceUsage } from '@/lib/deviceCatalog'
import { CheckCircle2 } from 'lucide-react'

// "How to use" sheet for a device — getting-started steps + indicator legend,
// tailored to the device type (from the catalog, generic fallback otherwise).
export function DeviceHelpDialog({
  device, onOpenChange,
}: {
  device: { name: string; model: string | null; kind: string } | null
  onOpenChange: (o: boolean) => void
}) {
  const art = device ? resolveDeviceModel(device.model, device.kind) : null
  const usage = device ? deviceUsage(device.model) : null

  return (
    <Dialog open={!!device} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="sr-only">How to use your device</DialogTitle>
        </DialogHeader>
        {device && art && usage && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <DeviceArt resolved={art} className="size-16" />
              <div>
                <p className="text-base font-semibold">{device.name}</p>
                <p className="text-xs text-muted-foreground">{deviceModelName(device.model, device.kind)}</p>
              </div>
            </div>

            <p className="rounded-control bg-muted/50 px-3 py-2.5 text-sm font-medium">{usage.headline}</p>

            <ol className="space-y-2">
              {usage.steps.map((s, i) => (
                <li key={i} className="flex gap-2.5 text-sm">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand/15 text-[11px] font-semibold text-brand">{i + 1}</span>
                  <span className="text-muted-foreground">{s}</span>
                </li>
              ))}
            </ol>

            {usage.indicators && usage.indicators.length > 0 && (
              <div className="space-y-1.5 rounded-card border border-border/50 p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium"><CheckCircle2 className="size-3.5 text-muted-foreground" /> What the light means</p>
                {usage.indicators.map((ind, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className={`size-2.5 shrink-0 rounded-full ${ind.color}`} />
                    {ind.meaning}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
