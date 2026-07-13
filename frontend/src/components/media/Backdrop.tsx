import { cn } from '@/lib/cn'
import { mediaImg } from '@/lib/shows/api'
import { useArtPalette } from '@/lib/artPalette'
import { UltraBlur } from '@/components/shared/UltraBlur'

// Cinema wallpaper behind a detail page: the title's backdrop art through the shared
// UltraBlur treatment (blurred art + corner colour washes), bounded to the top of the
// scroll container and dissolving into the page background so content stays readable.
// Shared by the Shows and Movies detail pages.
export function Backdrop({ url, className }: { url: string | null | undefined; className?: string }) {
  const art = url ? mediaImg(url) : null
  const palette = useArtPalette(art)
  if (!art) {
    return <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-0 h-[420px]', className)} />
  }
  return (
    <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-0 h-[420px] overflow-hidden', className)}>
      <UltraBlur artUrl={art} palette={palette} scrim="light" />
      {/* Dissolve into the page base so the hero text and the sections below stay legible. */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/40 to-background" />
    </div>
  )
}
