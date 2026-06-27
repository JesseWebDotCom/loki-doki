import type { ResolvedDevice } from '@/lib/deviceCatalog'

// Renders a device's illustration. `solid` forces an App-Store-style color-coded
// tile (the device-type gradient + a white lucide icon) — used on the device cards
// so each form factor reads at a glance. Without it, the bundled illustration shows
// on a soft tile (used in the wizard hero).
export function DeviceArt({ resolved, className, solid }: { resolved: ResolvedDevice; className?: string; solid?: boolean }) {
  const Icon = resolved.icon
  if (resolved.image && !solid) {
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
