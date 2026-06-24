import { useState } from 'react'
import { ExternalLink, Play, Star, ThumbsDown, ThumbsUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { mediaImg } from '@/lib/shows/api'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { Disc3 } from 'lucide-react'
import type {
  ParentsGuide,
  ReviewDigest,
  ShowCastMember,
  SoundtrackAlbum,
  StreamProvider,
  VideoLink,
  WebProvider,
} from '@/lib/shows/api'
import { SectionHeading } from './TitleCard'

// ── Where to stream ─────────────────────────────────────────────────────────────

const OFFER_RANK: Record<string, number> = { FLATRATE: 0, FREE: 1, ADS: 1, RENT: 2, BUY: 3, CINEMA: 4 }

// Secondary-source chips: shown when JustWatch lists no streaming, surfacing services a web
// search reported (often free/ad-supported ones JustWatch misses). Marked "reported" so it's
// clear these are less precise than JustWatch's direct links.
function WebProviderChips({ webProviders }: { webProviders: WebProvider[] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        JustWatch lists nothing, but other sources report it on (verify):
      </p>
      <div className="flex flex-wrap gap-2">
        {webProviders.map((w) => (
          <a
            key={w.name}
            href={w.searchUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border bg-foreground/5 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-foreground/10"
          >
            {w.name}
            <span className="text-xs text-muted-foreground">reported</span>
          </a>
        ))}
      </div>
    </div>
  )
}

export function StreamingChips({
  providers,
  theaters,
  justwatchUrl,
  webProviders,
}: {
  providers: StreamProvider[]
  theaters?: StreamProvider[]
  justwatchUrl?: string | null
  webProviders?: WebProvider[]
}) {
  const all = [...(theaters ?? []), ...providers].sort(
    (a, b) => (OFFER_RANK[a.offerType] ?? 9) - (OFFER_RANK[b.offerType] ?? 9),
  )
  if (!all.length) {
    if (webProviders && webProviders.length) return <WebProviderChips webProviders={webProviders} />
    return (
      <p className="text-sm text-muted-foreground">
        No streaming options found right now.
        {justwatchUrl && (
          <>
            {' '}
            <a href={justwatchUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
              Check JustWatch
            </a>
          </>
        )}
      </p>
    )
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {all.map((p, i) => (
          <a
            key={`${p.name}-${p.offerType}-${i}`}
            href={p.url || justwatchUrl || '#'}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground/8 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-foreground/12"
          >
            {p.name}
            <span className="text-xs text-muted-foreground">{p.label}</span>
          </a>
        ))}
      </div>
      {webProviders && webProviders.length > 0 && <WebProviderChips webProviders={webProviders} />}
    </div>
  )
}

// ── Videos (trailers / clips / music) ───────────────────────────────────────────

function VideoThumb({ video }: { video: VideoLink }) {
  const [ok, setOk] = useState(true)
  const { playExpanded } = useYoutubePlayback()
  return (
    <button
      type="button"
      onClick={() =>
        playExpanded({
          videoId: video.videoId,
          title: video.title,
          author: video.author,
          channelThumb: video.channelThumb,
          durationSec: video.durationSec,
          thumbnail: video.thumbnailUrl ?? undefined,
        })
      }
      className="group block w-[220px] shrink-0 text-left"
    >
      <div className="relative aspect-video overflow-hidden rounded-lg bg-muted ring-1 ring-border/40">
        {video.thumbnailUrl && ok ? (
          <img
            src={video.thumbnailUrl}
            alt={video.title}
            loading="lazy"
            className="size-full object-cover transition-transform group-hover:scale-105"
            onError={() => setOk(false)}
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Play className="size-6 text-muted-foreground/40" />
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <div className="rounded-full bg-black/60 p-2.5">
            <Play className="size-5 fill-white text-white" />
          </div>
        </div>
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-snug">{video.title}</p>
      {video.author && <p className="line-clamp-1 text-[11px] text-muted-foreground">{video.author}</p>}
    </button>
  )
}

export function VideoRow({ title, videos }: { title: string; videos: VideoLink[] }) {
  if (!videos.length) return null
  return (
    <div className="space-y-2.5">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {videos.map((v) => (
          <VideoThumb key={v.videoId} video={v} />
        ))}
      </div>
    </div>
  )
}

// ── Soundtrack albums (Apple Music / Spotify / … via Odesli) ─────────────────────

const PLATFORM_STYLE: Record<string, string> = {
  'Apple Music': 'bg-pink-500/15 text-pink-300 hover:bg-pink-500/25',
  Spotify: 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25',
  'YouTube Music': 'bg-red-500/15 text-red-300 hover:bg-red-500/25',
}

export function SoundtrackAlbums({ albums }: { albums: SoundtrackAlbum[] }) {
  if (!albums.length) return null
  return (
    <div className="space-y-2.5">
      <h3 className="text-sm font-semibold text-muted-foreground">Soundtrack albums</h3>
      <div className="space-y-2">
        {albums.map((al, i) => (
          <div key={`${al.name}-${i}`} className="flex gap-3 rounded-lg border border-border/50 p-3">
            <div className="size-16 shrink-0 overflow-hidden rounded-md bg-muted">
              {al.artworkUrl ? (
                <img src={al.artworkUrl} alt={al.name} loading="lazy" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center">
                  <Disc3 className="size-6 text-muted-foreground/40" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-sm font-medium">{al.name}</p>
              {al.artist && <p className="line-clamp-1 text-xs text-muted-foreground">{al.artist}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {al.links.map((l) => (
                  <a
                    key={l.platform}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                      PLATFORM_STYLE[l.platform] ?? 'bg-foreground/8 text-foreground hover:bg-foreground/12',
                    )}
                  >
                    {l.platform}
                  </a>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Reviews ──────────────────────────────────────────────────────────────────────

export function ReviewsSection({ reviews, loading }: { reviews: ReviewDigest | null | undefined; loading?: boolean }) {
  if (loading) return <p className="text-sm text-muted-foreground">Gathering reviews…</p>
  if (!reviews) return <p className="text-sm text-muted-foreground">No reviews found yet.</p>
  return (
    <div className="space-y-4">
      {reviews.scores.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {reviews.scores.map((s) => (
            <div key={s.source} className="rounded-lg bg-foreground/8 px-3 py-2">
              <p className="text-sm font-semibold">{s.value}</p>
              <p className="text-[11px] text-muted-foreground">{s.source}</p>
            </div>
          ))}
        </div>
      )}
      {reviews.summary && <p className="text-sm leading-relaxed text-muted-foreground">{reviews.summary}</p>}
      {(reviews.pros.length > 0 || reviews.cons.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {reviews.pros.length > 0 && (
            <div className="space-y-1.5">
              {reviews.pros.map((p, i) => (
                <p key={i} className="flex items-start gap-2 text-sm">
                  <ThumbsUp className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                  {p}
                </p>
              ))}
            </div>
          )}
          {reviews.cons.length > 0 && (
            <div className="space-y-1.5">
              {reviews.cons.map((c, i) => (
                <p key={i} className="flex items-start gap-2 text-sm">
                  <ThumbsDown className="mt-0.5 size-3.5 shrink-0 text-rose-500" />
                  {c}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      {reviews.sources.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {reviews.sources.map((s) => (
            <a
              key={s.url}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
            >
              <ExternalLink className="size-3" />
              {s.title.slice(0, 40)}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Trivia ───────────────────────────────────────────────────────────────────────

export function TriviaSection({ facts, loading }: { facts: string[] | undefined; loading?: boolean }) {
  if (loading) return <p className="text-sm text-muted-foreground">Digging up fun facts…</p>
  if (!facts || !facts.length) return <p className="text-sm text-muted-foreground">No trivia found yet.</p>
  return (
    <ul className="space-y-2.5">
      {facts.map((f, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm">
          <Star className="mt-0.5 size-3.5 shrink-0 fill-amber-400 text-amber-400" />
          <span className="leading-relaxed">{f}</span>
        </li>
      ))}
    </ul>
  )
}

// ── Parents guide (Common Sense Media) ──────────────────────────────────────────

function SeverityDots({ rating }: { rating?: number }) {
  const n = Math.max(0, Math.min(5, rating ?? 0))
  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={cn('size-1.5 rounded-full', i < n ? 'bg-amber-500' : 'bg-foreground/15')} />
      ))}
    </span>
  )
}

export function ParentsGuideSection({ guide }: { guide: ParentsGuide | null | undefined }) {
  if (!guide) return null
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {guide.ageRating && <Badge className="bg-violet-600/20 text-violet-300">{guide.ageRating}</Badge>}
        <a href={guide.url} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">
          Common Sense Media
        </a>
      </div>
      {guide.parentsNeedToKnow && (
        <p className="text-sm leading-relaxed text-muted-foreground">{guide.parentsNeedToKnow}</p>
      )}
      {guide.categories.length > 0 && (
        <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {guide.categories.map((c) => (
            <div key={c.label} className="flex items-center justify-between gap-3">
              <span className="text-sm">{c.label}</span>
              <SeverityDots rating={c.rating} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Cast ─────────────────────────────────────────────────────────────────────────

function CastCard({ member }: { member: ShowCastMember }) {
  const [ok, setOk] = useState(true)
  return (
    <div className="w-[96px] shrink-0 text-center">
      <div className="mx-auto size-[96px] overflow-hidden rounded-full bg-muted ring-1 ring-border/40">
        {member.image && ok ? (
          <img
            src={mediaImg(member.image)}
            alt={member.name}
            loading="lazy"
            className="size-full object-cover"
            onError={() => setOk(false)}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-lg font-semibold text-muted-foreground/50">
            {member.name.slice(0, 1)}
          </div>
        )}
      </div>
      <p className="mt-1.5 line-clamp-1 text-xs font-medium">{member.name}</p>
      {member.character && <p className="line-clamp-1 text-[11px] text-muted-foreground">{member.character}</p>}
    </div>
  )
}

export function CastRow({ cast }: { cast: ShowCastMember[] }) {
  if (!cast.length) return null
  return (
    <div>
      <SectionHeading>Cast</SectionHeading>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {cast.map((m, i) => (
          <CastCard key={`${m.name}-${i}`} member={m} />
        ))}
      </div>
    </div>
  )
}
