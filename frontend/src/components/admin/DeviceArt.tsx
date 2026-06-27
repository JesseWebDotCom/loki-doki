import type { ResolvedDevice } from '@/lib/deviceCatalog'

// Renders a device's illustration: the bundled image on a soft tile, or the
// gradient + lucide icon when there's no image. Used by the device cards + wizard.
export function DeviceArt({ resolved, className }: { resolved: ResolvedDevice; className?: string }) {
  const Icon = resolved.icon
  if (resolved.image) {
    return (
      <div className={`flex shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-muted/70 to-muted/20 ${className ?? 'size-14'}`}>
        <img src={resolved.image} alt={resolved.model} className="size-[78%] object-contain" loading="lazy" />
      </div>
    )
  }
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-2xl shadow-md ${className ?? 'size-14'}`}
      style={{ backgroundImage: resolved.gradient }}
    >
      <Icon className="size-1/2 text-white drop-shadow-sm" />
    </div>
  )
}
