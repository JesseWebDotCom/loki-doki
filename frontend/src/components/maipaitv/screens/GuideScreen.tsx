// The Prevue-style guide channel: a cycling featured now-playing panel up top
// and an endlessly scrolling grid of every channel's current and next program.

import { useQuery } from '@tanstack/react-query'
import { LayoutList } from 'lucide-react'
import { fetchTvGuide, tvClock, tvGlyph, type TvBlock, type TvGuideChannel } from '@/lib/maipaitv/api'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, channelPanelStyle, useCycle, useTick } from './shared'

function nowAndNext(ch: TvGuideChannel, now: number): { current: TvBlock | null; next: TvBlock | null } {
  const current = ch.blocks.find((b) => b.startAt <= now && b.endAt > now) ?? null
  const next = ch.blocks.find((b) => b.startAt > now) ?? null
  return { current, next }
}

function GuideRow({ ch, now }: { ch: TvGuideChannel; now: number }) {
  const { current, next } = nowAndNext(ch, now)
  return (
    <div className="grid h-16 grid-cols-[5rem_minmax(10rem,1.2fr)_2fr_1.6fr] items-center gap-4 border-b border-border/40 px-5">
      <span className="text-2xl font-bold tabular-nums" style={{ color: ch.color }}>{ch.number}</span>
      <span className="truncate text-lg font-semibold">{ch.name}</span>
      <span className="truncate text-lg text-foreground/85">
        {current ? current.title : 'Off the air'}
        {current ? <span className="ml-3 text-sm text-muted-foreground tabular-nums">{tvClock(current.startAt)} to {tvClock(current.endAt)}</span> : null}
      </span>
      <span className="truncate text-base text-muted-foreground">
        {next ? `Next at ${tvClock(next.startAt)}: ${next.title}` : 'No listings'}
      </span>
    </div>
  )
}

export function GuideScreen({ channel, title, subtitle }: TvScreenProps) {
  const guide = useQuery({
    queryKey: ['maipaitv', 'guide'],
    queryFn: () => fetchTvGuide(3),
    refetchInterval: 60_000,
  })
  const now = useTick(30_000)
  const channels = guide.data?.channels ?? []
  const featuredIdx = useCycle(channels.length, 8_000)

  if (guide.isPending) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={LayoutList} headline="Tuning the guide" note="Waiting for data" />
      </ScreenFrame>
    )
  }
  if (guide.isError || channels.length === 0) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={LayoutList} headline="The guide is off the air" note="Listings will return in a moment" />
      </ScreenFrame>
    )
  }

  const featured = channels[featuredIdx]
  const FeaturedGlyph = tvGlyph(featured.glyph)
  const { current: featNow, next: featNext } = nowAndNext(featured, now)
  const scrolling = channels.length > 6
  const rows = scrolling ? [...channels, ...channels] : channels

  return (
    <ScreenFrame
      channel={channel}
      title={title}
      subtitle={subtitle}
      right={<span className="text-lg font-semibold tabular-nums text-muted-foreground">{tvClock(now)}</span>}
    >
      <style>{'@keyframes maipaitv-guide-scroll { from { transform: translateY(0) } to { transform: translateY(-50%) } }'}</style>
      <div className="flex h-full flex-col gap-6">
        <div className="flex items-center gap-8 overflow-hidden rounded-sheet border border-border/50 p-8" style={channelPanelStyle(featured)}>
          <span className="flex size-24 shrink-0 items-center justify-center rounded-card bg-black/40">
            <FeaturedGlyph className="size-12" style={{ color: featured.color }} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold uppercase tracking-[0.3em] text-foreground/70">
              Channel {featured.number} <span className="mx-2">|</span> {featured.name}
            </p>
            <p className="mt-2 truncate text-4xl font-bold tracking-tight lg:text-5xl">
              {featNow ? featNow.title : featured.tagline ?? 'Off the air'}
            </p>
            <p className="mt-2 truncate text-lg text-foreground/70">
              {featNow?.subtitle ? `${featNow.subtitle}` : null}
              {featNow && !featNow.subtitle ? `On now until ${tvClock(featNow.endAt)}` : null}
              {!featNow && featNext ? `Coming up at ${tvClock(featNext.startAt)}: ${featNext.title}` : null}
            </p>
          </div>
          {featNow && featNext ? (
            <div className="hidden shrink-0 text-right xl:block">
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-foreground/60">Next</p>
              <p className="mt-1 max-w-56 truncate text-xl font-semibold">{featNext.title}</p>
              <p className="text-base text-foreground/70 tabular-nums">{tvClock(featNext.startAt)}</p>
            </div>
          ) : null}
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-sheet border border-border/50 bg-card/40">
          <div style={scrolling ? { animation: `maipaitv-guide-scroll ${channels.length * 4}s linear infinite` } : undefined}>
            {rows.map((ch, i) => <GuideRow key={`${ch.id}-${i}`} ch={ch} now={now} />)}
          </div>
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-black/50 to-transparent" />
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/50 to-transparent" />
        </div>
      </div>
    </ScreenFrame>
  )
}
