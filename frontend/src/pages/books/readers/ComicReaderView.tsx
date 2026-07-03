// CBZ reader: unzips the raw file client-side with fflate (same library the
// backend uses for EPUB) and pages through the extracted images. CBR uploads are
// transparently converted to CBZ at ingestion (backend/src/lib/books/comic.ts), so
// this is the only comic format the frontend ever has to handle.

import { useEffect, useRef, useState } from 'react'
import { unzipSync } from 'fflate'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { bookFileUrl, updateProgress, type BookDetail } from '@/lib/books/api'

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i
const PROGRESS_SAVE_MS = 2000

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export function ComicReaderView({ bookId, detail }: { bookId: string; detail: BookDetail | null }) {
  const [pages, setPages] = useState<string[]>([]) // object URLs, page order
  const [pageIdx, setPageIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const urlsRef = useRef<string[]>([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await fetch(bookFileUrl(bookId), { credentials: 'include' })
        if (!res.ok) throw new Error('download failed')
        const buf = new Uint8Array(await res.arrayBuffer())
        const entries = unzipSync(buf)
        const names = Object.keys(entries).filter((n) => IMAGE_EXT.test(n)).sort(naturalCompare)
        if (!names.length) throw new Error('no pages found')
        const urls = names.map((n) => URL.createObjectURL(new Blob([entries[n] as BlobPart])))
        if (cancelled) { urls.forEach((u) => URL.revokeObjectURL(u)); return }
        urlsRef.current = urls
        setPages(urls)
        const startPct = detail?.progress?.mode === 'reading' ? detail.progress.percent : 0
        setPageIdx(startPct > 0 ? Math.min(urls.length - 1, Math.max(0, Math.round(startPct * urls.length))) : 0)
        setLoading(false)
      } catch {
        if (!cancelled) { setError('Could not open this comic archive.'); setLoading(false) }
      }
    })()
    return () => {
      cancelled = true
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      urlsRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  useEffect(() => {
    if (loading || !pages.length) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void updateProgress(bookId, { mode: 'reading', percent: (pageIdx + 1) / pages.length, completed: pageIdx >= pages.length - 1 })
    }, PROGRESS_SAVE_MS)
  }, [pageIdx, loading, pages.length, bookId])

  if (error) return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{error}</div>

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-y-auto bg-black/40 py-4">
      {loading && <Spinner size="lg" />}
      {!loading && pages[pageIdx] && (
        <img src={pages[pageIdx]} alt={`Page ${pageIdx + 1}`} className="max-h-full max-w-full object-contain shadow-lg" />
      )}
      {!loading && pages.length > 0 && (
        <>
          <button onClick={() => setPageIdx((p) => Math.max(0, p - 1))} disabled={pageIdx <= 0}
            className="absolute inset-y-0 left-0 flex w-14 items-center justify-center text-white/30 transition-colors hover:text-white disabled:opacity-0">
            <ChevronLeft className="size-8" />
          </button>
          <button onClick={() => setPageIdx((p) => Math.min(pages.length - 1, p + 1))} disabled={pageIdx >= pages.length - 1}
            className="absolute inset-y-0 right-0 flex w-14 items-center justify-center text-white/30 transition-colors hover:text-white disabled:opacity-0">
            <ChevronRight className="size-8" />
          </button>
          <div className="sticky bottom-3 mt-3 rounded-full border border-border/50 bg-background/90 px-3 py-1.5 text-xs tabular-nums text-muted-foreground shadow">
            {pageIdx + 1} / {pages.length}
          </div>
        </>
      )}
    </div>
  )
}
