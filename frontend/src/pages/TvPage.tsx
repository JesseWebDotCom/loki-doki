import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Play, Shuffle, Tv } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { Spinner } from '@/components/ui/spinner'
import { getHubHistory, getFollowingFeed, playSomething, type HubVideoItem } from '@/lib/videos/api'
import { getHistory as getYtHistory } from '@/lib/youtube/api'
import { thumbUrl } from '@/lib/youtube/format'
import { toast } from 'sonner'

// TV mode: the 10-foot surface. Deliberately NOT the phone UI scaled up. Arrow keys /
// D-pad move a focus ring, Enter plays, and everything is big enough to read across a
// room. TV apps are the loudest chronic gap in the whole self-hosted ecosystem.
//
// This is a focused shell (resume, subscriptions, shuffle), not a port of every hub: a
// remote has five buttons, so the rails that matter from a sofa are the only ones here.
// Sign-in happens via Quick Connect (a code on the screen, approved from a phone) rather
// than typing a PIN with a remote.

interface TvRow {
  key: string
  title: string
  items: TvCard[]
}
interface TvCard {
  key: string
  title: string
  subtitle: string | null
  thumb: string | null
  to: string
  progress: number | null
}

export function TvPage() {
  const navigate = useNavigate()
  const [focus, setFocus] = useState({ row: 0, col: 0 })
  const [shuffling, setShuffling] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data: yt = [], isLoading: ytLoading } = useQuery({ queryKey: ['yt-history'], queryFn: getYtHistory })
  const { data: hub, isLoading: hubLoading } = useQuery({ queryKey: ['videos-history'], queryFn: getHubHistory })
  const { data: feedData, isLoading: feedLoading } = useQuery({ queryKey: ['videos-following-feed'], queryFn: () => getFollowingFeed(), staleTime: 60_000 })

  const rows = useMemo<TvRow[]>(() => {
    const resume: TvCard[] = [
      ...yt.filter((h) => !h.completed && h.positionSec > 5 && h.title.trim()).map((h) => ({
        key: `youtube:${h.videoId}`,
        title: h.title,
        subtitle: h.author,
        thumb: thumbUrl(h.videoId, 'hq'),
        to: `/videos/youtube/watch/${h.videoId}`,
        progress: h.durationSec ? h.positionSec / h.durationSec : null,
        updatedAt: h.updatedAt,
      })),
      ...(hub?.history ?? []).filter((h) => !h.completed && h.positionSec > 5 && h.title.trim()).map((h) => ({
        key: `${h.source}:${h.videoId}`,
        title: h.title,
        subtitle: h.creatorName,
        thumb: h.thumbnailUrl ? proxyImg(h.thumbnailUrl) : null,
        to: `/videos/${h.source}/watch/${encodeURIComponent(h.videoId)}`,
        progress: h.durationSec ? h.positionSec / h.durationSec : null,
        updatedAt: h.updatedAt,
      })),
    ].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12)

    const fresh: TvCard[] = (feedData?.items ?? []).slice(0, 16).map((i: HubVideoItem) => ({
      key: `${i.source}:${i.id}`,
      title: i.title,
      subtitle: i.creator?.name ?? null,
      thumb: i.thumbnailUrl ? proxyImg(i.thumbnailUrl) : null,
      to: `/videos/${i.source}/watch/${encodeURIComponent(i.id)}`,
      progress: null,
    }))

    const out: TvRow[] = []
    if (resume.length) out.push({ key: 'resume', title: 'Continue watching', items: resume })
    if (fresh.length) out.push({ key: 'fresh', title: 'New from your subscriptions', items: fresh })
    return out
  }, [yt, hub, feedData])

  const loading = ytLoading || hubLoading || feedLoading

  const shuffle = useCallback(async () => {
    if (shuffling) return
    setShuffling(true)
    try {
      const { item } = await playSomething()
      if (item) navigate(`/videos/${item.source}/watch/${encodeURIComponent(item.id)}`)
      else toast.info('Nothing to play yet.')
    } catch { toast.error('Could not pick a video') } finally { setShuffling(false) }
  }, [navigate, shuffling])

  // D-pad: arrows move the focus ring, Enter opens, and the shuffle tile lives at row -1
  // so Up from the first row lands on it (a remote has no Tab).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (rows.length === 0 && e.key !== 'Enter') return
      const row = rows[focus.row]
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault()
          if (row) setFocus((f) => ({ ...f, col: Math.min(f.col + 1, row.items.length - 1) }))
          break
        case 'ArrowLeft':
          e.preventDefault()
          setFocus((f) => ({ ...f, col: Math.max(0, f.col - 1) }))
          break
        case 'ArrowDown':
          e.preventDefault()
          setFocus((f) => ({ row: Math.min(f.row + 1, rows.length - 1), col: 0 }))
          break
        case 'ArrowUp':
          e.preventDefault()
          setFocus((f) => ({ row: Math.max(-1, f.row - 1), col: 0 }))
          break
        case 'Enter':
        case ' ':
          e.preventDefault()
          if (focus.row === -1) { void shuffle(); return }
          if (row?.items[focus.col]) navigate(row.items[focus.col]!.to)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, focus, navigate, shuffle])

  // Keep the focused card on screen as the ring moves.
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-tv-focused="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [focus])

  return (
    // TV mode is its own always-dark world: a living room is dark and a remote has no
    // theme toggle. Fixed + full-bleed so no app chrome intrudes.
    // design-ok(raw-overlay): a TV surface has no mobile dock or app shell to stay clear
    // of; the whole screen IS the app, which is the point of a 10-foot UI.
    <div data-theme="dark" ref={scrollRef}
      className="fixed inset-0 z-50 overflow-y-auto bg-black px-12 py-10 text-foreground">
      <div className="mb-8 flex items-center gap-4">
        <Tv className="size-7 text-brand" />
        {/* design-ok(raw-h1-in-pages): PageHeader's type scale is tuned for arm's length;
            a sofa needs its own, and this page is deliberately outside AppShell. */}
        <h1 className="text-3xl font-bold tracking-tight">Videos</h1>
        <div className="flex-1" />
        <button onClick={() => void shuffle()} data-tv-focused={focus.row === -1}
          className={cn('flex items-center gap-2.5 rounded-full px-6 py-3 text-lg font-semibold transition',
            focus.row === -1 ? 'bg-brand text-brand-foreground ring-4 ring-brand/40' : 'bg-foreground/10 text-foreground/80')}>
          {shuffling ? <Spinner className="size-5" /> : <Shuffle className="size-5" />} Play something
        </button>
      </div>

      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-32"><Spinner className="size-8" /></div>
      ) : rows.length === 0 ? (
        <p className="py-32 text-center text-xl text-muted-foreground">
          Nothing to watch yet. Subscribe to a few creators from a phone or computer.
        </p>
      ) : (
        <div className="space-y-10">
          {rows.map((row, ri) => (
            <section key={row.key}>
              <h2 className="mb-4 text-xl font-semibold text-foreground/80">{row.title}</h2>
              <div className="no-scrollbar flex gap-5 overflow-x-auto pb-2">
                {row.items.map((card, ci) => {
                  const focused = focus.row === ri && focus.col === ci
                  return (
                    <button key={card.key} data-tv-focused={focused}
                      onClick={() => navigate(card.to)}
                      onMouseEnter={() => setFocus({ row: ri, col: ci })}
                      className={cn('w-80 shrink-0 text-left transition-transform',
                        focused && 'scale-105')}>
                      <div className={cn('relative mb-2.5 aspect-video overflow-hidden rounded-card bg-muted transition',
                        focused ? 'ring-4 ring-brand' : 'ring-1 ring-white/10')}>
                        {card.thumb ? (
                          <img src={card.thumb} alt="" loading="lazy" className="size-full object-cover" />
                        ) : (
                          <div className="grid size-full place-items-center"><Play className="size-8 text-muted-foreground" /></div>
                        )}
                        {card.progress != null && (
                          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/60">
                            <div className="h-full bg-brand" style={{ width: `${Math.min(100, card.progress * 100)}%` }} />
                          </div>
                        )}
                      </div>
                      <p className="line-clamp-2 text-base font-semibold leading-snug">{card.title}</p>
                      {card.subtitle && <p className="mt-0.5 truncate text-sm text-muted-foreground">{card.subtitle}</p>}
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
