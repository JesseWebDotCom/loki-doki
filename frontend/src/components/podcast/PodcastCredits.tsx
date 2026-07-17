// Podcasting 2.0 surfaces: <podcast:person> credits, the <podcast:funding> link, and
// <podcast:soundbite> highlights. All three degrade to nothing when a feed omits them,
// so callers mount them unconditionally.

import { ExternalLink, Heart, Play, User } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { Button } from '@/components/ui/button'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { fmtTime } from '@/lib/podcast/format'
import type { PodcastFunding, PodcastPerson, PodcastSoundbite } from '@/lib/podcast/api'

/** The spec's default role is "host" when a person tag omits one. */
const roleOf = (p: PodcastPerson) => p.role || 'host'

/** Hosts lead, then guests, then everyone else - the order a listener expects. */
function byRole(a: PodcastPerson, b: PodcastPerson): number {
  const rank = (p: PodcastPerson) => (roleOf(p) === 'host' ? 0 : roleOf(p) === 'guest' ? 1 : 2)
  return rank(a) - rank(b)
}

function PersonChip({ person }: { person: PodcastPerson }) {
  const role = roleOf(person)
  const inner = (
    <>
      {person.img ? (
        <img src={proxyImg(person.img)} alt="" loading="lazy"
          className="size-8 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-muted-foreground">
          <User className="size-4" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{person.name}</span>
        <span className="block truncate text-[11px] capitalize text-muted-foreground">{role}</span>
      </span>
    </>
  )

  const className = cn(
    'flex items-center gap-2 rounded-full border border-border/60 bg-background/60 py-1 pl-1 pr-3',
    person.href && 'transition-colors hover:border-brand/40 hover:bg-accent/40',
  )

  return person.href
    ? <a href={person.href} target="_blank" rel="noreferrer" className={className}>{inner}</a>
    : <div className={className}>{inner}</div>
}

/** Person credits for a show or an episode. Episode credits win when present (a guest
 *  is per-episode); the show's cast is the fallback. */
export function PodcastCredits({ persons, title = 'Credits', className }: {
  persons: PodcastPerson[] | undefined
  title?: string
  className?: string
}) {
  const people = (persons ?? []).filter(p => p.name?.trim())
  if (!people.length) return null
  return (
    <section className={className}>
      <SectionHeader title={title} />
      <div className="mt-2 flex flex-wrap gap-2">
        {[...people].sort(byRole).map((p, i) => <PersonChip key={`${p.name}-${i}`} person={p} />)}
      </div>
    </section>
  )
}

/** The show's funding link, rendered as one restrained support button. */
export function PodcastFundingLink({ funding, className }: {
  funding: PodcastFunding[] | undefined
  className?: string
}) {
  const first = (funding ?? []).find(f => f.url)
  if (!first) return null
  return (
    <Button asChild variant="outline" size="sm" className={cn('gap-1.5', className)}>
      <a href={first.url} target="_blank" rel="noreferrer">
        <Heart className="size-3.5" />
        {first.label || 'Support this show'}
        <ExternalLink className="size-3 opacity-60" />
      </a>
    </Button>
  )
}

/** Soundbites as a Highlights list: tapping one seeks the player to that moment. */
export function PodcastHighlights({ soundbites, onSeek, className }: {
  soundbites: PodcastSoundbite[] | undefined
  onSeek: (startSec: number) => void
  className?: string
}) {
  const bites = (soundbites ?? []).filter(b => Number.isFinite(b.startSec))
  if (!bites.length) return null
  return (
    <section className={className}>
      <SectionHeader title="Highlights" />
      <p className="mt-0.5 text-xs text-muted-foreground">The good bits, picked by the show.</p>
      <div className="mt-2 grid gap-1">
        {bites.map((b, i) => (
          <button
            key={`${b.startSec}-${i}`}
            onClick={() => onSeek(b.startSec)}
            className="group flex items-center gap-3 rounded-card px-2 py-2 text-left transition hover:bg-accent/40"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-colors group-hover:bg-brand group-hover:text-brand-foreground">
              <Play className="ml-0.5 size-3.5 fill-current" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{b.title || `Highlight ${i + 1}`}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtTime(b.startSec)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
