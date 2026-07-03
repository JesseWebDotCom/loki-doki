// Format-aware dispatcher: fetches the book once, then hands off to the reader
// that knows how to render its stored ebook format. EPUB owns its own full-screen
// chrome (TOC/theme); PDF and CBZ share a minimal back-button bar here since their
// page-pager UI doesn't need anything else.

import { useEffect, useState } from 'react'
import { useNavigate, useParams, Navigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { getBook, type BookDetail } from '@/lib/books/api'
import { EpubReaderView } from './readers/EpubReaderView'
import { PdfReaderView } from './readers/PdfReaderView'
import { ComicReaderView } from './readers/ComicReaderView'

export function BookReaderPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<BookDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void getBook(id).then((d) => { if (!cancelled) { setDetail(d); setLoading(false) } })
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>
  }
  if (!detail) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Book not found.</div>
  }

  const ebookAsset = detail.assets.find((a) => a.kind === 'ebook' && a.status === 'ready')
  if (!ebookAsset) {
    const audioAsset = detail.assets.find((a) => a.kind === 'audio' && a.status === 'ready')
    if (audioAsset) return <Navigate to={`/books/listen/${id}`} replace />
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <p className="text-sm">This book isn't ready to read yet.</p>
        <Button variant="ghost" onClick={() => navigate('/books/library')}><ArrowLeft className="mr-1.5 size-4" />Back to Library</Button>
      </div>
    )
  }

  if (ebookAsset.format === 'epub') return <EpubReaderView bookId={id} detail={detail} />

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="glass-chrome sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate('/books/library')} title="Back"><ArrowLeft className="size-4" /></Button>
        <span className="flex-1 truncate text-sm font-medium">{detail.title}</span>
      </div>
      <div className="min-h-0 flex-1">
        {ebookAsset.format === 'pdf' && <PdfReaderView bookId={id} detail={detail} />}
        {ebookAsset.format === 'cbz' && <ComicReaderView bookId={id} detail={detail} />}
      </div>
    </div>
  )
}
