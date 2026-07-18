// <video> with the on-demand transcode fallback built in: give it the item's stream URL
// plus its compat endpoint, and a codec the browser can't decode swaps transparently to
// a server-transcoded rendition (with a small "Making playable…" chip meanwhile).
// For one-off inline players (dialogs, cards). Rich players wire useCompatSource directly.

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { useCompatSource } from '@/hooks/use-compat-source'

type Props = Omit<React.VideoHTMLAttributes<HTMLVideoElement>, 'src'> & {
  src: string
  /** The item's `.../compat` endpoint; null disables the fallback. */
  compatUrl: string | null
  wrapClassName?: string
}

export function CompatVideo({ src, compatUrl, wrapClassName, ...rest }: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const compat = useCompatSource(ref, compatUrl)

  // src is applied imperatively so the compat hook's swap is never clobbered by a re-render.
  useEffect(() => {
    const el = ref.current
    if (!el || compat.active) return
    const absolute = new URL(src, window.location.origin).href
    if (el.src !== absolute) el.src = src
  }, [src, compat.active])

  return (
    <div className={cn('relative', wrapClassName)}>
      <video ref={ref} {...rest} />
      {(compat.preparing || compat.failed) && (
        <span aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs font-medium text-white">
          {compat.failed ? 'Couldn’t convert this file' : `Making playable…${compat.progressPct != null ? ` ${compat.progressPct}%` : ''}`}
        </span>
      )}
    </div>
  )
}
