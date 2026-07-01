import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Play, Pause, RotateCcw, RotateCw, Moon, GripVertical, X, Download } from 'lucide-react'
import { cn } from '@/lib/cn'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { ShowCover } from '@/components/podcast/ShowCover'
import { getEpisodeDetail, type EpisodeDetail } from '@/lib/podcast/api'
import { fmtTime, fmtDate } from '@/lib/podcast/format'

type Tab = 'chapters' | 'transcript' | 'details'
const RATES = [0.75, 1, 1.25, 1.5, 2]
const SLEEP_OPTIONS = [0, 15, 30, 60] // minutes; 0 = off

export function NowPlaying() {
  const {
    track, playing, positionSec, duration, rate, autoplay, queue, queueIndex,
    pause, resume, seek, setRate, setAutoplay, playQueue, removeFromQueue,
  } = usePodcastPlayback()
  const [tab, setTab] = useState<Tab>('chapters')
  const [detail, setDetail] = useState<EpisodeDetail | null>(null)
  const [sleepMin, setSleepMin] = useState(0)
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setDetail(null)
    if (!track) return
    let alive = true
    getEpisodeDetail(track.episodeId).then(d => { if (alive) setDetail(d) }).catch(() => {})
    return () => { alive = false }
  }, [track?.episodeId])

  useEffect(() => {
    if (sleepTimer.current) clearTimeout(sleepTimer.current)
    if (sleepMin > 0) sleepTimer.current = setTimeout(() => pause(), sleepMin * 60_000)
    return () => { if (sleepTimer.current) clearTimeout(sleepTimer.current) }
  }, [sleepMin, track?.episodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!track) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-muted/50"><Play className="size-7 opacity-40" /></div>
        <p className="text-sm">Pick an episode to start listening.</p>
      </div>
    )
  }

  const total = track.durationSec || duration || 0
  const chapters = track.chapters ?? []
  const upNext = queue.slice(queueIndex + 1)

  const cycleRate = () => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1)
  const cycleSleep = () => setSleepMin(SLEEP_OPTIONS[(SLEEP_OPTIONS.indexOf(sleepMin) + 1) % SLEEP_OPTIONS.length] ?? 0)

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      {/* Cover + meta */}
      <ShowCover showId={track.showId ?? ''} title={track.showName} size={248} fill rounded="rounded-2xl" className="mx-auto aspect-square w-full max-w-[248px]" />
      <div className="mt-4">
        {track.showId
          ? <Link to={`/podcasts/show/${track.showId}`} className="text-xs font-semibold text-brand hover:underline">{track.showName}</Link>
          : <span className="text-xs font-semibold text-brand">{track.showName}</span>}
        <h2 className="mt-1 text-lg font-bold leading-snug">{track.title}</h2>
        {detail?.generatedAt && <p className="mt-1 text-xs text-muted-foreground">{fmtDate(detail.generatedAt)} · {fmtTime(total)}</p>}
      </div>

      {/* Scrubber */}
      <div className="mt-4">
        <input
          type="range" min={0} max={total || 100} step={1} value={positionSec}
          onChange={e => seek(Number(e.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-brand"
        />
        <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
          <span>{fmtTime(positionSec)}</span>
          <span>-{fmtTime(Math.max(0, total - positionSec))}</span>
        </div>
      </div>

      {/* Transport */}
      <div className="mt-3 flex items-center justify-between">
        <button onClick={cycleRate} className="w-10 text-sm font-semibold text-muted-foreground hover:text-foreground">{rate}x</button>
        <button onClick={() => seek(Math.max(0, positionSec - 15))} className="text-muted-foreground hover:text-foreground"><RotateCcw className="size-6" /></button>
        <button onClick={playing ? pause : resume} className="flex size-14 items-center justify-center rounded-full bg-brand text-brand-foreground hover:opacity-90">
          {playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current ml-0.5" />}
        </button>
        <button onClick={() => seek(positionSec + 15)} className="text-muted-foreground hover:text-foreground"><RotateCw className="size-6" /></button>
        <button onClick={cycleSleep} className={cn('flex w-10 flex-col items-center text-muted-foreground hover:text-foreground', sleepMin > 0 && 'text-brand')} title="Sleep timer">
          <Moon className="size-5" />
          {sleepMin > 0 && <span className="text-[9px] font-semibold leading-none">{sleepMin}m</span>}
        </button>
      </div>

      {/* Tabs */}
      <div className="mt-5 flex gap-5 border-b border-border/40">
        {([['chapters', 'Chapters'], ['transcript', 'Transcript'], ['details', 'Details']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={cn('-mb-px border-b-2 pb-2 text-sm font-semibold transition-colors',
              tab === id ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>

      <div className="py-3">
        {tab === 'chapters' && (
          chapters.length > 0 ? (
            <div className="space-y-0.5">
              {chapters.map((ch, i) => {
                const active = positionSec >= ch.startSec && (chapters[i + 1] == null || positionSec < chapters[i + 1].startSec)
                return (
                  <button key={i} onClick={() => seek(ch.startSec)}
                    className={cn('flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                      active ? 'text-brand font-semibold' : 'text-muted-foreground')}>
                    <span className="tabular-nums text-xs">{fmtTime(ch.startSec)}</span>
                    <span className="truncate">{ch.title}</span>
                  </button>
                )
              })}
            </div>
          ) : <p className="px-2 py-6 text-center text-sm text-muted-foreground/60">No chapters.</p>
        )}

        {tab === 'transcript' && (
          detail == null ? <p className="px-2 py-6 text-center text-sm text-muted-foreground/60">Loading…</p>
          : detail.transcript.length > 0 ? (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{detail.transcript.length} turns</span>
                <button
                  onClick={() => {
                    const header = [
                      'PODCAST TRANSCRIPT',
                      `Show: ${track.showName}`,
                      `Episode: ${track.title}`,
                      detail.generatedAt ? `Date: ${fmtDate(detail.generatedAt)}` : '',
                    ].filter(Boolean).join('\n')
                    const body = detail.transcript.map(t => `${t.speaker.toUpperCase()}\n${t.text}`).join('\n\n')
                    const text = `${header}\n\n${'─'.repeat(40)}\n\n${body}`
                    const blob = new Blob([text], { type: 'text/plain' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `${track.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-transcript.txt`
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  title="Download transcript"
                >
                  <Download className="size-3.5" />
                  Download
                </button>
              </div>
              <div className="space-y-3">
                {detail.transcript.map((t, i) => (
                  <div key={i}>
                    <p className="text-xs font-semibold text-brand">{t.speaker}</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">{t.text}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : <p className="px-2 py-6 text-center text-sm text-muted-foreground/60">No transcript available.</p>
        )}

        {tab === 'details' && (
          <dl className="divide-y divide-border/40 text-sm">
            {track.description && <p className="pb-3 text-muted-foreground leading-relaxed">{track.description}</p>}
            {[
              ['Show', track.showName],
              ['Published', detail?.generatedAt ? fmtDate(detail.generatedAt) : '—'],
              ['Duration', total ? fmtTime(total) : '—'],
              ['Chapters', String(chapters.length)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between py-2"><dt className="text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>
            ))}
          </dl>
        )}
      </div>

      {/* Up Next */}
      {(upNext.length > 0 || queue.length > 1) && (
        <div className="mt-2 border-t border-border/40 pt-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold">Up Next</h3>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Autoplay
              <button
                role="switch" aria-checked={autoplay} onClick={() => setAutoplay(!autoplay)}
                className={cn('relative h-5 w-9 rounded-full transition-colors', autoplay ? 'bg-emerald-500' : 'bg-muted')}>
                <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-transform', autoplay ? 'translate-x-4' : 'translate-x-0.5')} />
              </button>
            </label>
          </div>
          {upNext.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground/60">Nothing queued.</p>
          ) : (
            <div className="space-y-1">
              {upNext.map((t) => {
                const realIndex = queue.findIndex(q => q.episodeId === t.episodeId)
                return (
                  <div key={t.episodeId} className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-muted">
                    <GripVertical className="size-3.5 shrink-0 text-muted-foreground/40" />
                    <button onClick={() => playQueue(queue, realIndex)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <ShowCover showId={t.showId ?? ''} title={t.showName} size={36} rounded="rounded-md" />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">{t.title}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{t.showName}</p>
                      </div>
                    </button>
                    <button onClick={() => removeFromQueue(t.episodeId)} className="shrink-0 text-muted-foreground/50 opacity-0 hover:text-foreground group-hover:opacity-100"><X className="size-3.5" /></button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
