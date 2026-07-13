// Two playback shapes share this page: a single Range-served file (uploaded
// audiobook or a TTS-rendered one, seeking via audioStartSec/EndSec offsets; not
// used directly here, the whole file just plays through) and "multi-track" books
// (LibriVox via Internet Archive) where every chapter is its own external URL,
// proxied through /api/books/:id/chapters/:idx/stream. Progress is throttled to
// the bookProgress table so listening position syncs across devices.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Bookmark, BookmarkPlus, Check, ChevronLeft, ChevronRight, Moon, Pause, Play, RotateCcw, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { BookCover } from '@/components/books/BookCover'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { accentOf, DEFAULT_PALETTE, readableOn, useArtPalette } from '@/lib/artPalette'
import { accentVars } from '@/components/shared/ArtAccentScope'
import { UltraBlur } from '@/components/shared/UltraBlur'
import { SeekBar } from '@/components/shared/SeekBar'
import {
  getBook, getChapters, updateProgress, bookAudioUrl, bookCoverUrl, chapterStreamUrl,
  type BookDetail, type BookChapter,
} from '@/lib/books/api'

const PROGRESS_SAVE_MS = 5000
const RATES = [0.75, 1, 1.25, 1.5, 2]
// Sleep-timer cycle: off → minute presets → end-of-chapter → off.
const SLEEP_OPTIONS: (number | 'chapter' | null)[] = [null, 15, 30, 45, 60, 'chapter']

interface AudioBookmark { chapterIdx: number; positionSec: number; label: string; createdAt: number }

function loadBookmarks(bookId: string): AudioBookmark[] {
  try { return JSON.parse(localStorage.getItem(`book-audio-bm:${bookId}`) ?? '[]') as AudioBookmark[] } catch { return [] }
}
function saveBookmarks(bookId: string, list: AudioBookmark[]): void {
  try { localStorage.setItem(`book-audio-bm:${bookId}`, JSON.stringify(list)) } catch { /* quota / private mode */ }
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

function formatDuration(sec: number | null): string {
  if (!sec || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function AudiobookPlayerPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const audioRef = useRef<HTMLAudioElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [detail, setDetail] = useState<BookDetail | null>(null)
  const [chapters, setChapters] = useState<BookChapter[]>([])
  const [chapterIdx, setChapterIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  // Styled-transport state mirroring the hidden <audio> element (which remounts per
  // chapter via key={src}; the events effect below re-attaches on chapter change).
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)
  const [rate, setRate] = useState(1)
  const [sleep, setSleep] = useState<number | 'chapter' | null>(null)
  const [bookmarks, setBookmarks] = useState<AudioBookmark[]>([])
  // Seek target to apply once the (possibly newly-mounted) audio element is ready,
  // used when jumping to a bookmark in a different chapter.
  const pendingSeekRef = useRef<number | null>(null)

  useEffect(() => { setBookmarks(loadBookmarks(id)) }, [id])

  // Sleep timer. Minute presets pause after a fixed delay; 'chapter' pauses at the
  // next chapter end (handled in the audio 'ended' handler via sleepRef).
  const sleepRef = useRef<number | 'chapter' | null>(null)
  sleepRef.current = sleep
  useEffect(() => {
    if (sleep === null || sleep === 'chapter' || !playing) return
    const t = setTimeout(() => { audioRef.current?.pause(); setSleep(null) }, sleep * 60_000)
    return () => clearTimeout(t)
  }, [sleep, playing])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([getBook(id), getChapters(id)]).then(([d, ch]) => {
      if (cancelled) return
      setDetail(d)
      setChapters(ch)
      setChapterIdx(d?.progress?.mode === 'listening' ? d.progress.audioChapterIdx ?? 0 : 0)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [id])

  const multiTrack = chapters.some((c) => c.externalAudioUrl)
  const currentChapter = multiTrack ? chapters[chapterIdx] : null

  const saveProgress = useCallback((audio: HTMLAudioElement) => {
    const dur = audio.duration || 0
    if (multiTrack) {
      const totalDur = chapters.reduce((sum, c) => sum + (c.externalAudioDurationSec ?? 0), 0)
      const elapsedBefore = chapters.slice(0, chapterIdx).reduce((sum, c) => sum + (c.externalAudioDurationSec ?? 0), 0)
      const percent = totalDur > 0 ? (elapsedBefore + audio.currentTime) / totalDur : 0
      void updateProgress(id, {
        mode: 'listening', audioPositionSec: audio.currentTime, audioChapterIdx: chapterIdx,
        percent, completed: chapterIdx >= chapters.length - 1 && dur > 0 && audio.currentTime / dur >= 0.98,
        elapsedDeltaSec: PROGRESS_SAVE_MS / 1000,
      })
    } else {
      void updateProgress(id, {
        mode: 'listening', audioPositionSec: audio.currentTime,
        percent: dur > 0 ? audio.currentTime / dur : 0,
        completed: dur > 0 && audio.currentTime / dur >= 0.98,
        elapsedDeltaSec: PROGRESS_SAVE_MS / 1000,
      })
    }
  }, [id, multiTrack, chapters, chapterIdx])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !detail || loading) return
    const pending = pendingSeekRef.current
    pendingSeekRef.current = null
    const resumeAt = pending != null ? pending
      : (detail.progress?.mode === 'listening' && (!multiTrack || detail.progress.audioChapterIdx === chapterIdx)
          ? detail.progress.audioPositionSec ?? 0 : 0)
    if (resumeAt > 1) {
      const onLoaded = () => { audio.currentTime = resumeAt; if (pending != null) void audio.play() }
      audio.addEventListener('loadedmetadata', onLoaded, { once: true })
    }

    const onTimeUpdate = () => {
      setPos(audio.currentTime)
      if (saveTimerRef.current) return
      saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; saveProgress(audio) }, PROGRESS_SAVE_MS)
    }
    const onEnded = () => {
      if (sleepRef.current === 'chapter') { audio.pause(); setSleep(null); return }
      if (multiTrack && chapterIdx < chapters.length - 1) setChapterIdx((i) => i + 1)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onDuration = () => setDur(audio.duration || 0)
    audio.playbackRate = rate
    setPos(audio.currentTime)
    setDur(audio.duration || 0)
    setPlaying(!audio.paused)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('loadedmetadata', onDuration)
    audio.addEventListener('durationchange', onDuration)
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('loadedmetadata', onDuration)
      audio.removeEventListener('durationchange', onDuration)
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, loading, chapterIdx, multiTrack])

  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = rate }, [rate])

  // Cover palette for the UltraBlur backdrop + accent transport (hooks stay above the
  // early returns; coverSrc is null until the book loads, which useArtPalette accepts).
  const hasEbookAsset = detail?.assets.some((a) => a.kind === 'ebook' && a.status === 'ready') ?? false
  const coverArt = detail ? (hasEbookAsset ? bookCoverUrl(id) : (detail.coverUrl ? proxyImg(detail.coverUrl) : null)) : null
  const palette = useArtPalette(coverArt)
  const accent = accentOf(palette)

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>
  if (!detail) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Book not found.</div>

  const src = multiTrack && currentChapter ? chapterStreamUrl(id, currentChapter.idx) : bookAudioUrl(id)
  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) void a.play()
    else a.pause()
  }
  const skip = (delta: number) => {
    const a = audioRef.current
    if (a) a.currentTime = Math.max(0, Math.min(a.duration || Infinity, a.currentTime + delta))
  }
  const cycleRate = () => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1)
  const cycleSleep = () => setSleep(SLEEP_OPTIONS[(SLEEP_OPTIONS.indexOf(sleep) + 1) % SLEEP_OPTIONS.length] ?? null)
  const sleepLabel = sleep === null ? 'Sleep' : sleep === 'chapter' ? 'End of chapter' : `${sleep}m`
  const addBookmark = () => {
    const a = audioRef.current
    if (!a) return
    const label = currentChapter ? `${currentChapter.title} · ${fmtClock(a.currentTime)}` : fmtClock(a.currentTime)
    const next = [...bookmarks, { chapterIdx, positionSec: a.currentTime, label, createdAt: Date.now() }].slice(-50)
    setBookmarks(next); saveBookmarks(id, next)
  }
  const jumpBookmark = (bm: AudioBookmark) => {
    if (multiTrack && bm.chapterIdx !== chapterIdx) { pendingSeekRef.current = bm.positionSec; setChapterIdx(bm.chapterIdx) }
    else { const a = audioRef.current; if (a) { a.currentTime = bm.positionSec; void a.play() } }
  }
  const deleteBookmark = (createdAt: number) => {
    const next = bookmarks.filter((b) => b.createdAt !== createdAt)
    setBookmarks(next); saveBookmarks(id, next)
  }

  // Always-dark immersive player (the Books equivalent of Music's Now Playing):
  // cover through UltraBlur, transport and chapter chrome tinted to the cover palette.
  return (
    <div data-theme="dark" className="relative flex h-full flex-col overflow-hidden bg-black text-foreground"
      style={palette !== DEFAULT_PALETTE ? accentVars(palette) : undefined}>
      <UltraBlur artUrl={coverArt} palette={palette} />
      <div className="relative flex shrink-0 items-center gap-2 px-4 py-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/books/detail/${id}`)}>
          <ArrowLeft className="mr-1.5 size-4" />Back
        </Button>
      </div>

      <div className="relative flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8">
        <div className="w-44 shrink-0 sm:w-52">
          <div className="aspect-[2/3] overflow-hidden rounded-card shadow-2xl ring-1 ring-white/10"
            style={{ boxShadow: `0 30px 120px -20px ${palette.vibrant}` }}>
            <BookCover bookId={id} title={detail.title} author={detail.author} coverSrc={coverArt} fill size={320} />
          </div>
        </div>
        <div className="text-center">
          <h2 className="text-title">{detail.title}</h2>
          {detail.author && <p className="text-sm text-muted-foreground">{detail.author}</p>}
          {currentChapter && <p className="mt-1 text-xs text-muted-foreground">{currentChapter.title}</p>}
        </div>

        {/* Styled transport over a hidden <audio>: the element, its remount-per-chapter
            key, and the progress/resume plumbing are unchanged. */}
        <div className="w-full max-w-md">
          <SeekBar pos={pos} total={dur || 0} onSeek={(t) => { const a = audioRef.current; if (a) a.currentTime = t }} accent={accent} />
          <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
            <span>{fmtClock(pos)}</span>
            <span>-{fmtClock(Math.max(0, dur - pos))}</span>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <button onClick={cycleRate} className="w-10 text-sm font-semibold text-muted-foreground hover:text-foreground" title="Playback speed">{rate}x</button>
          {multiTrack && (
            <Button variant="ghost" size="icon-sm" disabled={chapterIdx <= 0} onClick={() => setChapterIdx((i) => Math.max(0, i - 1))} aria-label="Previous chapter">
              <ChevronLeft className="size-5" />
            </Button>
          )}
          <button onClick={() => skip(-15)} className="relative text-muted-foreground hover:text-foreground" aria-label="Back 15 seconds">
            <RotateCcw className="size-6" />
          </button>
          <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}
            className="flex size-14 items-center justify-center rounded-full shadow-lg transition-transform active:scale-95"
            style={{ background: accent, color: readableOn(accent) }}>
            {playing ? <Pause className="size-6 fill-current" /> : <Play className="ml-0.5 size-6 fill-current" />}
          </button>
          <button onClick={() => skip(30)} className="relative text-muted-foreground hover:text-foreground" aria-label="Forward 30 seconds">
            <RotateCw className="size-6" />
          </button>
          {multiTrack && (
            <Button variant="ghost" size="icon-sm" disabled={chapterIdx >= chapters.length - 1} onClick={() => setChapterIdx((i) => Math.min(chapters.length - 1, i + 1))} aria-label="Next chapter">
              <ChevronRight className="size-5" />
            </Button>
          )}
        </div>
        {multiTrack && (
          <span className="-mt-3 text-xs tabular-nums text-muted-foreground">Chapter {chapterIdx + 1} / {chapters.length}</span>
        )}

        {/* Secondary controls: sleep timer + add bookmark */}
        <div className="flex items-center gap-2">
          <button onClick={cycleSleep}
            className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
              sleep !== null ? 'border-white/30 bg-white/15 text-foreground' : 'border-white/10 text-muted-foreground hover:text-foreground')}
            title="Sleep timer">
            <Moon className="size-3.5" />{sleepLabel}
          </button>
          <button onClick={addBookmark}
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            title="Bookmark this spot">
            <BookmarkPlus className="size-3.5" />Bookmark
          </button>
        </div>

        <audio key={src} ref={audioRef} src={src} autoPlay={multiTrack && chapterIdx > 0} className="hidden" />

        {bookmarks.length > 0 && (
          <div className="w-full max-w-md">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><Bookmark className="size-3.5" />Bookmarks</p>
            <div className="overflow-hidden rounded-card border border-white/10 bg-black/30">
              {[...bookmarks].sort((a, b) => b.createdAt - a.createdAt).map((bm) => (
                <div key={bm.createdAt} className="flex items-center gap-2 border-b border-white/5 px-3 py-2 text-sm last:border-0">
                  <button type="button" onClick={() => jumpBookmark(bm)} className="min-w-0 flex-1 truncate text-left hover:text-brand">{bm.label}</button>
                  <button type="button" onClick={() => deleteBookmark(bm.createdAt)} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Delete bookmark">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {multiTrack && (
          <div className="w-full max-w-md overflow-y-auto rounded-card border border-white/10 bg-black/30">
            {chapters.map((c) => (
              <button
                key={c.idx}
                type="button"
                onClick={() => setChapterIdx(c.idx)}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-white/5 px-3 py-2 text-left text-sm last:border-0 hover:bg-white/10',
                  c.idx === chapterIdx && 'bg-white/10 font-medium',
                )}
              >
                {c.idx === chapterIdx ? <Check className="size-3.5 shrink-0 text-brand" /> : <span className="w-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {c.externalAudioDurationSec && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(c.externalAudioDurationSec)}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
