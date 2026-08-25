import { useEffect, useState } from 'react'
import { History, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { getRecap } from '@/lib/youtube/api'
import { AiGeneratedBadge } from '@/components/shared/AiGeneratedBadge'

const POLL_MS = 6_000
const MAX_POLLS = 6
const SHOW_MS = 20_000
const FADE_MS = 500

/** "Previously..." card over the player when resuming well past the start: a 2-3
 *  sentence AI reminder of everything before the resume point (never past it, so it
 *  can't spoil). The server builds it in the background on a cache miss, so a pending
 *  response is polled a few times while playback continues. Auto-hides after 20s with
 *  a fade; the X dismisses it early. Mount keyed on the video so state never leaks
 *  across navigations. */
export function ResumeRecapOverlay({ videoId, atSec }: { videoId: string; atSec: number }) {
  const [recap, setRecap] = useState<string | null>(null)
  const [fading, setFading] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  // Fetch once, then poll every 6s (up to 6 tries) while the server is still building.
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let polls = 0
    const load = async () => {
      const res = await getRecap(videoId, atSec).catch(() => null)
      if (!alive || !res) return
      if (res.recap) { setRecap(res.recap); return }
      if (res.pending && polls < MAX_POLLS) { polls += 1; timer = setTimeout(() => { void load() }, POLL_MS) }
    }
    void load()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [videoId, atSec])

  // Once the text is on screen, fade it out and drop it after 20 seconds.
  useEffect(() => {
    if (!recap) return
    const fade = setTimeout(() => setFading(true), SHOW_MS)
    const gone = setTimeout(() => setDismissed(true), SHOW_MS + FADE_MS)
    return () => { clearTimeout(fade); clearTimeout(gone) }
  }, [recap])

  if (!recap || dismissed) return null
  return (
    // design-ok(backdrop-blur-outside-chrome): recap card floats over the video surface, styled like the player's other overlays
    <div className={cn(
      'absolute left-3 top-3 z-30 max-w-[min(560px,calc(100%-1.5rem))] rounded-card border border-white/10 bg-black/70 p-3 text-white shadow-xl backdrop-blur animate-in fade-in transition-opacity duration-500',
      fading && 'opacity-0',
    )}>
      <div className="flex items-center gap-1.5">
        <History className="size-3.5 shrink-0 text-white/70" aria-hidden />
        <p className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-white/70">Previously</p>
        {/* design-ok(hand-styled-button) design-ok(glass-on-plain-bg): dismiss chip over the video surface, styled like the player's other chips */}
        <button onClick={() => setDismissed(true)} aria-label="Dismiss"
          className="shrink-0 rounded-full p-0.5 text-white/70 transition hover:bg-white/10 hover:text-white">
          <X className="size-3.5" />
        </button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed">{recap}</p>
      <AiGeneratedBadge label="Summarized by MaiPai" className="mt-2" />
    </div>
  )
}
