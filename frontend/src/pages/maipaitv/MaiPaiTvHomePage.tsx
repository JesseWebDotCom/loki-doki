// The MaiPai TV hub: the channel dial. Every enabled channel as a card with its logo
// tile, number, and what is on right now; grouped the way the dial is numbered.

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Play, Tv } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchTvGuide, tvGlyph, type TvGuideChannel } from '@/lib/maipaitv/api'

const GROUPS: Array<{ label: string; match: (n: number) => boolean }> = [
  { label: 'Movies & Shows', match: (n) => n >= 2 && n <= 9 },
  { label: 'Audio', match: (n) => n >= 10 && n <= 19 },
  { label: 'Live & Around the House', match: (n) => n >= 20 && n <= 39 },
  { label: 'Dashboards', match: (n) => n >= 40 && n <= 59 },
  { label: 'The MaiPai Network', match: (n) => n >= 60 },
]

function ChannelCard({ channel }: { channel: TvGuideChannel }) {
  const now = Date.now()
  const current = channel.blocks.find((b) => b.startAt <= now && b.endAt > now)
  const Glyph = tvGlyph(channel.glyph)
  return (
    <Link
      to={`/channels/watch/${channel.slug}`}
      className="group flex items-center gap-3 rounded-card border border-border/60 bg-card/70 p-3 transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:bg-card"
    >
      <div
        className="relative flex size-14 shrink-0 flex-col items-center justify-center rounded-card text-white shadow-lg"
        style={{ background: `linear-gradient(135deg, ${channel.color}, ${channel.colorDark})` }}
      >
        <Glyph className="size-5" />
        <span className="text-[10px] font-extrabold tabular-nums">{channel.number}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-white">{channel.name}</p>
        <p className="truncate text-xs text-white/55">{current?.title ?? channel.tagline ?? 'Off the air'}</p>
      </div>
      <Play className="size-4 shrink-0 text-white/30 transition-colors group-hover:text-white" />
    </Link>
  )
}

export function MaiPaiTvHomePage() {
  const { data, isLoading } = useQuery({
    queryKey: ['tv-guide-home'],
    queryFn: () => fetchTvGuide(1),
    refetchInterval: 60_000,
  })

  const channels = data?.channels ?? []
  const firstSlug = channels[0]?.slug
  const grouped = useMemo(() =>
    GROUPS.map((g) => ({ label: g.label, channels: channels.filter((c) => g.match(c.number)) }))
      .filter((g) => g.channels.length > 0),
  [channels])
  const guideChannel = channels.find((c) => c.number === 1)

  return (
    <PageContainer>
      <PageHeader
        eyebrow="MaiPai TV"
        title="Channels"
        subtitle="Real TV, made from this house. Flip on and see what is playing."
        actions={firstSlug ? (
          <Link
            to={`/channels/watch/${guideChannel?.slug ?? firstSlug}`}
            className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-bold text-brand-foreground transition-transform hover:scale-[1.02]"
          >
            <Tv className="size-4" />
            Turn on the TV
          </Link>
        ) : undefined}
      />

      {isLoading && channels.length === 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-card" />
          ))}
        </div>
      ) : null}

      {guideChannel ? (
        <section className="mb-8">
          <SectionHeader title="Guide" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <ChannelCard channel={guideChannel} />
          </div>
        </section>
      ) : null}

      {grouped.map((group) => (
        <section key={group.label} className="mb-8">
          <SectionHeader title={group.label} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.channels.map((ch) => <ChannelCard key={ch.id} channel={ch} />)}
          </div>
        </section>
      ))}
    </PageContainer>
  )
}
