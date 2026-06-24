import { useState } from 'react'
import { cn } from '@/lib/cn'
import { mediaImg } from '@/lib/shows/api'

// Full-bleed blurred wallpaper behind a detail page. Sits at the top of the scroll
// container, fading into the page background so content below stays readable. Shared by the
// Shows and Movies detail pages.
export function Backdrop({ url, className }: { url: string | null | undefined; className?: string }) {
  const [ok, setOk] = useState(true)
  if (!url || !ok) {
    return <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-0 h-[420px]', className)} />
  }
  return (
    <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-0 h-[420px] overflow-hidden', className)}>
      <img
        src={mediaImg(url)}
        alt=""
        aria-hidden
        className="size-full scale-110 object-cover opacity-40 blur-2xl"
        onError={() => setOk(false)}
      />
      {/* Scrim: darken toward the bottom so the hero text and the page below stay legible. */}
      <div className="absolute inset-0 bg-gradient-to-b from-background/30 via-background/70 to-background" />
    </div>
  )
}
