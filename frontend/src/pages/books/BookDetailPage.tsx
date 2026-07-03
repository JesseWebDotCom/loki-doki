// The "product page" for a single book, the piece the Library/Discover grids
// were missing entirely. This is where Read/Listen/Download live as clear
// buttons and where "Convert to Audiobook" is surfaced as a real, described
// feature instead of a small icon buried in the EPUB reader's top bar.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, BookOpen, Download, Headphones, RotateCw, Sparkles } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { BookCover } from '@/components/books/BookCover'
import {
  getBook, getChapters, bookCoverUrl, bookFileUrl, bookAudioUrl, enqueueBookTts, getBookTtsStatus,
  retryBookDownload, type BookDetail, type BookChapter,
} from '@/lib/books/api'
import { proxyImg } from '@/lib/img'

const TTS_POLL_MS = 3000
const DOWNLOAD_POLL_MS = 3000

function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.round((totalSec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function safeFilename(title: string, ext: string): string {
  return `${title.replace(/[/\\?%*:|"<>]/g, '').trim().slice(0, 120)}.${ext}`
}

export function BookDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<BookDetail | null>(null)
  const [chapters, setChapters] = useState<BookChapter[]>([])
  const [loading, setLoading] = useState(true)
  const [ttsStatus, setTtsStatus] = useState<'idle' | 'rendering' | 'ready' | 'failed'>('idle')
  const [retrying, setRetrying] = useState(false)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const downloadPollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    const [d, ch] = await Promise.all([getBook(id), getChapters(id)])
    setDetail(d)
    setChapters(ch)
    setLoading(false)
    if (d?.assets.some((a) => a.kind === 'audio' && a.status === 'ready')) setTtsStatus('ready')
  }, [id])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current)
    if (downloadPollRef.current) clearTimeout(downloadPollRef.current)
  }, [])

  // While a fresh add is still downloading, poll for it to land so Read/Download
  // appear without a manual refresh.
  useEffect(() => {
    if (detail?.libraryStatus !== 'pending' && detail?.libraryStatus !== 'downloading') return
    downloadPollRef.current = setTimeout(() => { void load() }, DOWNLOAD_POLL_MS)
    return () => { if (downloadPollRef.current) clearTimeout(downloadPollRef.current) }
  }, [detail?.libraryStatus, load])

  const poll = useCallback(() => {
    pollRef.current = setTimeout(async () => {
      const s = await getBookTtsStatus(id)
      if (s.status === 'ready') { setTtsStatus('ready'); await load() }
      else if (s.status === 'failed') setTtsStatus('failed')
      else poll()
    }, TTS_POLL_MS)
  }, [id, load])

  const startConversion = useCallback(async () => {
    setTtsStatus('rendering')
    try {
      const { ready } = await enqueueBookTts(id)
      if (ready) { setTtsStatus('ready'); await load() }
      else poll()
    } catch {
      setTtsStatus('failed')
    }
  }, [id, poll, load])

  const retryDownload = useCallback(async () => {
    setRetrying(true)
    try {
      await retryBookDownload(id)
      await load()
    } finally {
      setRetrying(false)
    }
  }, [id, load])

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>
  if (!detail) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Book not found.</div>

  const ebookAsset = detail.assets.find((a) => a.kind === 'ebook' && a.status === 'ready')
  const audioAsset = detail.assets.find((a) => a.kind === 'audio' && a.status === 'ready')
  const isEpub = ebookAsset?.format === 'epub'
  const isMultiTrackAudio = chapters.some((c) => c.externalAudioUrl)
  const coverSrc = isEpub ? bookCoverUrl(id) : (detail.coverUrl ? proxyImg(detail.coverUrl) : null)
  const readingProgress = detail.progress?.mode === 'reading' ? detail.progress.percent : 0
  const listeningProgress = detail.progress?.mode === 'listening' ? detail.progress.percent : 0
  const audioDurationSec = chapters.reduce((sum, c) => sum + (c.externalAudioDurationSec ?? 0), 0)
  const lengthLabel = audioAsset && audioDurationSec > 0 ? formatDuration(audioDurationSec)
    : ebookAsset && chapters.length > 0 ? `${chapters.length} chapters`
    : null

  const isDownloading = detail.libraryStatus === 'pending' || detail.libraryStatus === 'downloading'
  const isFailed = detail.libraryStatus === 'failed'
  const notReadyYet = !ebookAsset && !audioAsset

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="pb-16">
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/books/library')}>
          <ArrowLeft className="mr-1.5 size-4" />Library
        </Button>

        <div className="mt-4 flex flex-col gap-8 sm:flex-row">
          <div className="mx-auto w-48 shrink-0 sm:mx-0 sm:w-56">
            <div className="aspect-[2/3] overflow-hidden rounded-card shadow-lg">
              <BookCover bookId={id} title={detail.title} author={detail.author} coverSrc={coverSrc} fill size={320} />
            </div>
          </div>

          <div className="min-w-0 flex-1">
            {/* design-ok(raw-h1-in-pages): custom two-column product hero, PageHeader's icon-tile layout doesn't fit */}
            <h1 className="text-display">{detail.title}</h1>
            {detail.author && <p className="mt-1 text-lg text-muted-foreground">{detail.author}</p>}

            <div className="mt-3 flex flex-wrap gap-2">
              {ebookAsset && (
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {ebookAsset.format}
                </span>
              )}
              {audioAsset && (
                <span className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  <Headphones className="size-3" />Audiobook
                </span>
              )}
              {detail.language && (
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">{detail.language}</span>
              )}
              {lengthLabel && (
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">{lengthLabel}</span>
              )}
            </div>

            {detail.description && (
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">{detail.description}</p>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {ebookAsset && (
                <>
                  <Button size="lg" onClick={() => navigate(`/books/read/${id}`)}>
                    <BookOpen className="mr-2 size-4" />
                    {readingProgress > 0 ? 'Continue Reading' : 'Read'}
                  </Button>
                  <Button size="lg" variant="outline" asChild>
                    <a href={bookFileUrl(id)} download={safeFilename(detail.title, ebookAsset.format)} title="Download a copy to your device">
                      <Download className="mr-2 size-4" />Download
                    </a>
                  </Button>
                </>
              )}
              {audioAsset && (
                <>
                  <Button size="lg" variant={ebookAsset ? 'outline' : 'default'} onClick={() => navigate(`/books/listen/${id}`)}>
                    <Headphones className="mr-2 size-4" />
                    {listeningProgress > 0 ? 'Continue Listening' : 'Listen'}
                  </Button>
                  {!isMultiTrackAudio && (
                    <Button size="lg" variant="outline" asChild>
                      <a href={bookAudioUrl(id)} download={safeFilename(detail.title, audioAsset.format)} title="Download a copy to your device">
                        <Download className="mr-2 size-4" />Download
                      </a>
                    </Button>
                  )}
                </>
              )}
              {notReadyYet && isDownloading && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner size="sm" />Downloading…
                </p>
              )}
              {notReadyYet && isFailed && (
                <div className="flex items-center gap-2">
                  <p className="flex items-center gap-1.5 text-sm text-destructive">
                    <AlertTriangle className="size-4" />Download failed
                  </p>
                  <Button size="sm" variant="outline" disabled={retrying} onClick={() => void retryDownload()}>
                    {retrying ? <Spinner size="sm" className="mr-1.5" /> : <RotateCw className="mr-1.5 size-3.5" />}
                    Retry
                  </Button>
                </div>
              )}
              {notReadyYet && !isDownloading && !isFailed && (
                <p className="text-sm text-muted-foreground">This book isn't ready yet.</p>
              )}
            </div>

            {isEpub && !audioAsset && (
              <div className="mt-8 max-w-xl rounded-card border border-[var(--books-accent)]/30 bg-[var(--books-accent-soft)] p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-[var(--books-accent-soft)]">
                    <Sparkles className="size-5 text-[var(--books-accent-fg)]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Convert to Audiobook</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      Generate a narrated audiobook with AI. Dialogue is automatically detected and each character
                      gets a distinct voice, the same engine behind "Cast voices".
                    </p>
                    <Button className="mt-3" size="sm" variant="outline" disabled={ttsStatus === 'rendering'} onClick={() => void startConversion()}>
                      {ttsStatus === 'rendering' ? <><Spinner size="sm" className="mr-1.5" />Converting…</> : 'Convert to Audiobook'}
                    </Button>
                    {ttsStatus === 'failed' && <p className="mt-2 text-xs text-destructive">Conversion failed, try again.</p>}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </PageContainer>
    </div>
  )
}
