// PDF reader: pdf.js renders directly from the raw file URL; no server-side page
// extraction needed. Progress is tracked as a page-fraction percent (no CFI concept
// for PDF).

import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
// eslint-disable-next-line import/no-unresolved
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { bookFileUrl, updateProgress, type BookDetail } from '@/lib/books/api'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const PROGRESS_SAVE_MS = 2000

export function PdfReaderView({ bookId, detail }: { bookId: string; detail: BookDetail | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageNum, setPageNum] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const loadingTask = pdfjsLib.getDocument({ url: bookFileUrl(bookId) })
    loadingTaskRef.current = loadingTask
    void (async () => {
      try {
        const doc = await loadingTask.promise
        if (cancelled) { void loadingTask.destroy(); return }
        docRef.current = doc
        setNumPages(doc.numPages)
        const startPct = detail?.progress?.mode === 'reading' ? detail.progress.percent : 0
        setPageNum(startPct > 0 ? Math.min(doc.numPages, Math.max(1, Math.round(startPct * doc.numPages))) : 1)
        setLoading(false)
      } catch {
        if (!cancelled) { setError('Could not open this PDF. It may be corrupt.'); setLoading(false) }
      }
    })()
    return () => {
      cancelled = true
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      void loadingTaskRef.current?.destroy()
      loadingTaskRef.current = null
      docRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  useEffect(() => {
    if (loading || !docRef.current || !canvasRef.current) return
    let cancelled = false
    void (async () => {
      const page = await docRef.current!.getPage(pageNum)
      if (cancelled) return
      const viewport = page.getViewport({ scale: 1.6 })
      const canvas = canvasRef.current!
      canvas.width = viewport.width
      canvas.height = viewport.height
      await page.render({ canvas, viewport }).promise
    })()

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void updateProgress(bookId, { mode: 'reading', percent: pageNum / Math.max(1, numPages), completed: pageNum >= numPages })
    }, PROGRESS_SAVE_MS)

    return () => { cancelled = true }
  }, [pageNum, loading, bookId, numPages])

  if (error) return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{error}</div>

  return (
    <div className="relative flex h-full flex-col items-center overflow-y-auto bg-black/20 py-4">
      {loading && <div className="absolute inset-0 flex items-center justify-center"><Spinner size="lg" /></div>}
      <canvas ref={canvasRef} className="max-w-full shadow-lg" />
      {!loading && numPages > 0 && (
        <div className="sticky bottom-3 mt-3 flex items-center gap-3 rounded-full border border-border/50 bg-background/90 px-3 py-1.5 shadow">
          <button onClick={() => setPageNum((p) => Math.max(1, p - 1))} disabled={pageNum <= 1} className="disabled:opacity-30"><ChevronLeft className="size-4" /></button>
          <span className="text-xs tabular-nums text-muted-foreground">{pageNum} / {numPages}</span>
          <button onClick={() => setPageNum((p) => Math.min(numPages, p + 1))} disabled={pageNum >= numPages} className="disabled:opacity-30"><ChevronRight className="size-4" /></button>
        </div>
      )}
    </div>
  )
}
