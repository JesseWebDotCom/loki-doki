// Shared-album slideshow: one photo at a time with a slow Ken Burns drift and
// a crossfade every 8 seconds. CDN links are short-lived, so the list refetches
// every 10 minutes.

import { useQuery } from '@tanstack/react-query'
import { Images } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { TvChannel } from '@/lib/dokitv/api'
import type { TvScreenProps } from './index'
import { ScreenEyebrow, StatusPanel, channelWash, getJson, isFeatureOff, retryUnlessOff, useCycle } from './shared'

interface SharedPhoto {
  guid: string
  url: string
  caption: string | null
  album: string
  isVideo: boolean
}

const KEYFRAMES = `
@keyframes dokitv-kb-a { from { transform: scale(1.06) translate(1.5%, 1%) } to { transform: scale(1.18) translate(-1.5%, -1.5%) } }
@keyframes dokitv-kb-b { from { transform: scale(1.06) translate(-1.5%, -1%) } to { transform: scale(1.18) translate(1.5%, 1.5%) } }
@keyframes dokitv-slide-fade { from { opacity: 0 } to { opacity: 1 } }
`

function FramedPanel({ channel, title, subtitle, children }: {
  channel: TvChannel
  title: string
  subtitle?: string | null
  children: React.ReactNode
}) {
  return (
    <div data-theme="dark" className="relative h-full w-full overflow-hidden bg-black text-foreground">
      <div aria-hidden className="absolute inset-0" style={channelWash(channel)} />
      <div className="relative z-10 flex h-full flex-col gap-6 p-8 lg:p-10">
        <ScreenEyebrow channel={channel} title={title} subtitle={subtitle} />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  )
}

export function MemoriesScreen({ channel, title, subtitle }: TvScreenProps) {
  const photos = useQuery({
    queryKey: ['dokitv', 'memories'],
    queryFn: () => getJson<{ photos: SharedPhoto[] }>('/api/icloud/shared-albums/photos'),
    refetchInterval: 10 * 60_000,
    retry: retryUnlessOff,
  })

  const stills = (photos.data?.photos ?? []).filter((p) => !p.isVideo)
  const idx = useCycle(stills.length, 8_000)

  if (photos.isError) {
    const off = isFeatureOff(photos.error)
    return (
      <FramedPanel channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel
          channel={channel}
          icon={Images}
          headline={off ? 'Photos are not connected' : 'Memories are unavailable'}
          note={off ? 'An admin can add an iCloud shared album to start the slideshow' : 'We could not load the shared albums'}
        />
      </FramedPanel>
    )
  }
  if (photos.isPending) {
    return (
      <FramedPanel channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Images} headline="Gathering memories" note="Waiting for data" />
      </FramedPanel>
    )
  }
  if (stills.length === 0) {
    return (
      <FramedPanel channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Images} headline="No photos yet" note="Photos added to the shared albums will play here" />
      </FramedPanel>
    )
  }

  const current = stills[idx]
  const prev = stills[(idx - 1 + stills.length) % stills.length]
  // Keep the outgoing layer mounted (stable keys) so the incoming one fades
  // over it; each layer's Ken Burns animation keeps running across the swap.
  const layers = prev.guid !== current.guid ? [prev, current] : [current]

  return (
    <div data-theme="dark" className="relative h-full w-full overflow-hidden bg-black text-foreground">
      <style>{KEYFRAMES}</style>
      {layers.map((p, li) => {
        const photoIdx = stills.indexOf(p)
        return (
          <div
            key={p.guid}
            className="absolute inset-0"
            style={li === layers.length - 1 ? { animation: 'dokitv-slide-fade 1.6s ease-in-out both' } : undefined}
          >
            <img
              src={p.url}
              alt={p.caption ?? p.album}
              decoding="async"
              className="h-full w-full object-cover"
              style={{ animation: `${photoIdx % 2 === 0 ? 'dokitv-kb-a' : 'dokitv-kb-b'} 24s ease-in-out both` }}
            />
          </div>
        )
      })}

      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/70 to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/75 to-transparent" />

      <div className="absolute inset-x-0 top-0 p-8 lg:p-10">
        <ScreenEyebrow channel={channel} title={title} subtitle={subtitle} />
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-6 p-8 lg:p-10">
        <p className={cn('min-w-0 truncate text-3xl font-semibold', !current.caption && 'text-foreground/70')}>
          {current.caption ?? 'From the family albums'}
        </p>
        <span className="flex shrink-0 items-center gap-2 rounded-full bg-black/60 px-5 py-2 text-lg font-semibold">
          <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: channel.color }} />
          {current.album}
        </span>
      </div>
    </div>
  )
}
