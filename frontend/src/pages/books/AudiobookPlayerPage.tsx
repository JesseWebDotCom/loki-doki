// Two playback shapes share this page: a single Range-served file (uploaded
// audiobook or a TTS-rendered one, seeking via audioStartSec/EndSec offsets; not
// used directly here, the whole file just plays through) and "multi-track" books
// (LibriVox via Internet Archive) where every chapter is its own external URL,
// proxied through /api/books/:id/chapters/:idx/stream. Progress is throttled to
// the bookProgress table so listening position syncs across devices.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { BookCover } from '@/components/books/BookCover'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import {
  getBook, getChapters, updateProgress, bookAudioUrl, bookCoverUrl, chapterStreamUrl,
  type BookDetail, type BookChapter,
} from '@/lib/books/api'

const PROGRESS_SAVE_MS = 5000

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
      })
    } else {
      void updateProgress(id, {
        mode: 'listening', audioPositionSec: audio.currentTime,
        percent: dur > 0 ? audio.currentTime / dur : 0,
        completed: dur > 0 && audio.currentTime / dur >= 0.98,
      })
    }
  }, [id, multiTrack, chapters, chapterIdx])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !detail || loading) return
    const resumeAt = detail.progress?.mode === 'listening' && (!multiTrack || detail.progress.audioChapterIdx === chapterIdx)
      ? detail.progress.audioPositionSec ?? 0 : 0
    if (resumeAt > 1) {
      const onLoaded = () => { audio.currentTime = resumeAt }
      audio.addEventListener('loadedmetadata', onLoaded, { once: true })
    }

    const onTimeUpdate = () => {
      if (saveTimerRef.current) return
      saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; saveProgress(audio) }, PROGRESS_SAVE_MS)
    }
    const onEnded = () => {
      if (multiTrack && chapterIdx < chapters.length - 1) setChapterIdx((i) => i + 1)
    }
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('ended', onEnded)
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, loading, chapterIdx, multiTrack])

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>
  if (!detail) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Book not found.</div>

  const src = multiTrack && currentChapter ? chapterStreamUrl(id, currentChapter.idx) : bookAudioUrl(id)
  const hasEbook = detail.assets.some((a) => a.kind === 'ebook' && a.status === 'ready')
  const coverSrc = hasEbook ? bookCoverUrl(id) : (detail.coverUrl ? proxyImg(detail.coverUrl) : null)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/books/detail/${id}`)}>
          <ArrowLeft className="mr-1.5 size-4" />Back
        </Button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8">
        <div className="size-40 shrink-0 overflow-hidden rounded-card shadow-lg">
          <BookCover bookId={id} title={detail.title} author={detail.author} coverSrc={coverSrc} fill size={320} />
        </div>
        <div className="text-center">
          <h2 className="text-title">{detail.title}</h2>
          {detail.author && <p className="text-sm text-muted-foreground">{detail.author}</p>}
          {currentChapter && <p className="mt-1 text-xs text-muted-foreground">{currentChapter.title}</p>}
        </div>

        {multiTrack && (
          <div className="flex items-center gap-3">
            <Button variant="outline" size="icon-sm" disabled={chapterIdx <= 0} onClick={() => setChapterIdx((i) => Math.max(0, i - 1))}>
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">Chapter {chapterIdx + 1} / {chapters.length}</span>
            <Button variant="outline" size="icon-sm" disabled={chapterIdx >= chapters.length - 1} onClick={() => setChapterIdx((i) => Math.min(chapters.length - 1, i + 1))}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}

        <audio key={src} ref={audioRef} src={src} controls autoPlay={multiTrack && chapterIdx > 0} className="w-full max-w-md" />

        {multiTrack && (
          <div className="w-full max-w-md overflow-y-auto rounded-card border border-border/50">
            {chapters.map((c) => (
              <button
                key={c.idx}
                type="button"
                onClick={() => setChapterIdx(c.idx)}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-border/30 px-3 py-2 text-left text-sm last:border-0 hover:bg-accent/50',
                  c.idx === chapterIdx && 'bg-accent/70 font-medium',
                )}
              >
                {c.idx === chapterIdx ? <Check className="size-3.5 shrink-0 text-[var(--books-accent-fg)]" /> : <span className="w-3.5 shrink-0" />}
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
