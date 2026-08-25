// The TV: full-pane player for one channel. Resolves what is on now, mounts the right
// renderer for the block kind, refetches at block boundaries, and gives the classic
// TV verbs: channel up/down (buttons + arrow keys), number entry, info banner, guide.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, LayoutList, Pause, X } from 'lucide-react'
import { acquireAudio, registerMediaStop, registerTransport } from '@/lib/mediaCoordinator'
import { fetchTvChannels, fetchTvNow, type TvNow } from '@/lib/maipaitv/api'
import { TvMediaRenderer } from '@/components/maipaitv/TvMediaRenderer'
import { TvLiveRenderer } from '@/components/maipaitv/TvLiveRenderer'
import { TvAudioRenderer } from '@/components/maipaitv/TvAudioRenderer'
import { TvInfoBanner } from '@/components/maipaitv/TvInfoBanner'
import { TvGuideOverlay } from '@/components/maipaitv/TvGuideOverlay'
import { TvSlate } from '@/components/maipaitv/TvSlate'
import { TV_SCREENS } from '@/components/maipaitv/screens'

function BlockSurface({ now, suspended, onBlockDone }: { now: TvNow; suspended: boolean; onBlockDone: () => void }) {
  const { channel, block, next } = now
  if (!block) {
    return <TvSlate channel={channel} headline="Off the air" message="Nothing is scheduled right now. Check back in a moment." />
  }
  const payload = block.payload
  switch (payload.src) {
    case 'plex':
    case 'youtube':
    case 'segment':
      return <TvMediaRenderer channel={channel} block={block} suspended={suspended} onEnded={onBlockDone} />
    case 'live':
      return <TvLiveRenderer channel={channel} block={block} suspended={suspended} />
    case 'station':
    case 'live-radio':
    case 'podcast':
      return <TvAudioRenderer channel={channel} block={block} suspended={suspended} />
    case 'page': {
      const Screen = TV_SCREENS[payload.screen]
      if (!Screen) return <TvSlate channel={channel} headline={block.title} message="This screen is not available yet." />
      return <Screen channel={channel} title={block.title} subtitle={block.subtitle} />
    }
    case 'filler':
      return <TvSlate channel={channel} headline="We will be right back" nextTitle={payload.nextTitle ?? next[0]?.title ?? null} />
    case 'offair':
      return (
        <TvSlate
          channel={channel}
          headline={payload.reason === 'signoff' ? 'Off air until morning' : payload.reason === 'coming-soon' ? 'Signing on soon' : `${channel.name} is off the air`}
          message={payload.message}
          variant={payload.reason === 'signoff' ? 'signoff' : 'default'}
          nextTitle={next[0]?.title ?? null}
        />
      )
  }
}

export function TvWatchPage() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
  const [bannerVisible, setBannerVisible] = useState(true)
  const [guideOpen, setGuideOpen] = useState(false)
  const [suspended, setSuspended] = useState(false)
  const [digits, setDigits] = useState('')
  const digitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { data: channels } = useQuery({ queryKey: ['tv-channels'], queryFn: fetchTvChannels, staleTime: 5 * 60_000 })
  const { data: now, refetch } = useQuery({
    queryKey: ['tv-now', slug],
    queryFn: () => fetchTvNow(slug),
    refetchInterval: 60_000,
    enabled: !!slug,
  })

  // Refetch right when the current block ends so the next program starts on time.
  useEffect(() => {
    if (!now?.block) return
    const ms = now.block.endAt - Date.now() + 750
    // Clock skew guard: if the client clock runs ahead of the server, endAt can already
    // be in the past while the server still returns the same block. Back off instead of
    // polling at the floor every 1.5s until the server-side boundary passes.
    const t = setTimeout(() => { void refetch() }, ms <= 0 ? 15_000 : Math.max(1500, ms))
    return () => clearTimeout(t)
  }, [now, refetch])

  // TV owns the audio focus while mounted; if another app grabs it, pause instead of
  // fighting (mediaCoordinator contract). Registering a transport keeps device remotes
  // (Listening Together, controller buttons) functional while the TV holds the slot.
  useEffect(() => {
    acquireAudio('tv')
    const unregisterStop = registerMediaStop('tv', () => setSuspended(true))
    const unregisterTransport = registerTransport('tv', {
      toggle: () => setSuspended((s) => { if (s) acquireAudio('tv'); return !s }),
      next: () => tuneByRef.current(1),
      prev: () => tuneByRef.current(-1),
      seek: () => { /* linear TV has no seek */ },
      stop: () => setSuspended(true),
    })
    return () => { unregisterStop(); unregisterTransport() }
  }, [])

  // The digit-entry timer must not survive unmount: it navigates, and an orphaned
  // timer would turn the TV back on from whatever page the user went to.
  useEffect(() => () => { if (digitTimer.current) clearTimeout(digitTimer.current) }, [])

  const tuneBy = useCallback((delta: number) => {
    if (!channels?.length) return
    const sorted = [...channels].sort((a, b) => a.number - b.number)
    const idx = sorted.findIndex((c) => c.slug === slug)
    const next = sorted[(idx + delta + sorted.length) % sorted.length]
    if (next) navigate(`/channels/watch/${next.slug}`)
  }, [channels, slug, navigate])
  // Stable handle for the transport registration (registered once on mount).
  const tuneByRef = useRef(tuneBy)
  useEffect(() => { tuneByRef.current = tuneBy }, [tuneBy])

  const tuneToNumber = useCallback((num: number) => {
    const target = channels?.find((c) => c.number === num)
    if (target) navigate(`/channels/watch/${target.slug}`)
  }, [channels, navigate])

  // Show the banner briefly on every channel change, and treat zapping as intent to
  // resume watching if the TV was paused for another audio source.
  useEffect(() => {
    setBannerVisible(true)
    setSuspended((wasSuspended) => {
      if (wasSuspended) acquireAudio('tv')
      return false
    })
    const t = setTimeout(() => setBannerVisible(false), 5000)
    return () => clearTimeout(t)
  }, [slug])

  // Remote-control keys: arrows zap, digits jump, g guide, i info.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowUp') { e.preventDefault(); tuneBy(1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); tuneBy(-1) }
      else if (e.key === 'g' || e.key === 'G') setGuideOpen((v) => !v)
      else if (e.key === 'i' || e.key === 'I') setBannerVisible((v) => !v)
      else if (/^[0-9]$/.test(e.key)) {
        setDigits((prev) => {
          const nextDigits = (prev + e.key).slice(-3)
          if (digitTimer.current) clearTimeout(digitTimer.current)
          digitTimer.current = setTimeout(() => {
            tuneToNumber(Number(nextDigits))
            setDigits('')
          }, 1200)
          return nextDigits
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tuneBy, tuneToNumber])

  const surface = useMemo(() => now
    ? <BlockSurface now={now} suspended={suspended} onBlockDone={() => { void refetch() }} />
    : <div className="h-full w-full bg-black" />,
  [now, suspended, refetch])

  return (
    <div className="absolute inset-0 select-none bg-black">
      {/* Tap the picture to bring the banner back (and hide it again on a second tap). */}
      <div className="absolute inset-0" onClick={() => setBannerVisible((v) => !v)}>
        {surface}
      </div>

      {suspended ? (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/80 backdrop-blur-sm">
          <Pause className="size-10 text-white/70" />
          <p className="text-sm text-white/70">TV paused because audio started somewhere else</p>
          <button
            type="button"
            onClick={() => { acquireAudio('tv'); setSuspended(false) }}
            className="rounded-full bg-brand px-5 py-2.5 text-sm font-bold text-brand-foreground"
          >
            Resume watching
          </button>
        </div>
      ) : null}

      {digits ? (
        <div className="absolute right-6 top-6 z-20 rounded-card bg-black/70 px-4 py-2 text-3xl font-extrabold tabular-nums text-white backdrop-blur">
          {digits}
        </div>
      ) : null}

      {/* Right-edge remote rail */}
      <div className="absolute right-3 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-2">
        <button type="button" onClick={() => tuneBy(1)} aria-label="Channel up"
          className="flex size-11 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur transition-colors hover:bg-black/70 hover:text-white">
          <ChevronUp className="size-5" />
        </button>
        <button type="button" onClick={() => setGuideOpen(true)} aria-label="Open guide"
          className="flex size-11 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur transition-colors hover:bg-black/70 hover:text-white">
          <LayoutList className="size-5" />
        </button>
        <button type="button" onClick={() => tuneBy(-1)} aria-label="Channel down"
          className="flex size-11 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur transition-colors hover:bg-black/70 hover:text-white">
          <ChevronDown className="size-5" />
        </button>
      </div>

      {/* Close back to the dial */}
      <button type="button" onClick={() => navigate('/channels')} aria-label="Back to channels"
        className="absolute left-3 top-3 z-20 flex size-11 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur transition-colors hover:bg-black/70 hover:text-white">
        <X className="size-5" />
      </button>

      {now ? <TvInfoBanner now={now} visible={bannerVisible && !guideOpen} /> : null}
      <TvGuideOverlay
        open={guideOpen}
        activeSlug={slug}
        onClose={() => setGuideOpen(false)}
        onTune={(s) => navigate(`/channels/watch/${s}`)}
      />
    </div>
  )
}
