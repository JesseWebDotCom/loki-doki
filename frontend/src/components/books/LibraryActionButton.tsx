// The Save / Download-offline control for a storefront search result, shared by
// shelf tiles (variant="overlay", icon-only, floats over the cover), search cards
// and the preview page (variant="inline", labelled buttons). State is read from
// the shared library-index store so every instance for the same item stays in
// sync. Preview-only sources (Google Books, Open Library) have no downloadable
// file, so this renders nothing for them — they keep just their "Preview" affordance.

import { useState, type MouseEvent } from 'react'
import { Bookmark, BookmarkCheck, Check, Download, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import type { BookSearchResult } from '@/lib/books/api'
import { useLibraryEntry, saveResult, downloadResult, downloadSaved } from '@/lib/books/libraryIndex'

const PREVIEW_ONLY_SOURCES = new Set(['googlebooks', 'openlibrary'])

interface LibraryActionButtonProps {
  result: BookSearchResult
  variant?: 'overlay' | 'inline'
  className?: string
}

export function LibraryActionButton({ result, variant = 'inline', className }: LibraryActionButtonProps) {
  const entry = useLibraryEntry(result.source, result.sourceRef)
  const [busy, setBusy] = useState<null | 'save' | 'download'>(null)

  if (PREVIEW_ONLY_SOURCES.has(result.source)) return null

  const status = entry?.status
  const downloading = status === 'pending' || status === 'downloading'
  const offline = status === 'ready'
  const failed = status === 'failed'

  async function run(kind: 'save' | 'download', fn: () => Promise<void>, okMsg: string) {
    setBusy(kind)
    try {
      await fn()
      toast.success(okMsg)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  const onSave = () => run('save', () => saveResult(result), 'Saved to your library')
  const onDownload = () => run(
    'download',
    () => (entry ? downloadSaved(result.source, result.sourceRef, entry.bookId) : downloadResult(result)),
    'Downloading for offline…',
  )

  // ── Overlay (shelf tile): compact icon buttons floating over the cover ──
  if (variant === 'overlay') {
    const stop = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation() }
    const iconBtn = 'flex size-8 items-center justify-center rounded-full bg-black/60 text-white shadow-md backdrop-blur transition hover:bg-black/80 disabled:opacity-70'
    return (
      <div className={cn('absolute right-1.5 top-1.5 z-10 flex gap-1', className)} onClick={stop}>
        {offline ? (
          <span className={cn(iconBtn, 'bg-[var(--books-accent)]/90 cursor-default hover:bg-[var(--books-accent)]/90')} title="Downloaded — available offline">
            <Check className="size-4" />
          </span>
        ) : downloading ? (
          <span className={cn(iconBtn, 'cursor-default')} title="Downloading…"><Spinner size="sm" className="text-white" /></span>
        ) : (
          <>
            <button type="button" className={iconBtn} disabled={busy !== null} title={status === 'saved' ? 'Saved' : 'Save to library'}
              onClick={(e) => { stop(e); if (status !== 'saved') void onSave() }}>
              {busy === 'save' ? <Spinner size="sm" className="text-white" /> : status === 'saved' ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
            </button>
            <button type="button" className={iconBtn} disabled={busy !== null} title={failed ? 'Retry download' : 'Download for offline'}
              onClick={(e) => { stop(e); void onDownload() }}>
              {busy === 'download' ? <Spinner size="sm" className="text-white" /> : failed ? <RotateCw className="size-4" /> : <Download className="size-4" />}
            </button>
          </>
        )}
      </div>
    )
  }

  // ── Inline (card / preview page): labelled buttons ──
  if (offline) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 rounded-full bg-[var(--books-accent-soft)] px-3 py-1.5 text-sm font-medium text-[var(--books-accent-fg)]', className)}>
        <Check className="size-4" />Available offline
      </span>
    )
  }
  if (downloading) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-sm text-muted-foreground', className)}>
        <Spinner size="sm" />Downloading…
      </span>
    )
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Button size="sm" variant="outline" disabled={busy !== null || status === 'saved'} onClick={() => void onSave()}>
        {busy === 'save' ? <Spinner size="sm" className="mr-1.5" /> : status === 'saved' ? <BookmarkCheck className="mr-1.5 size-4" /> : <Bookmark className="mr-1.5 size-4" />}
        {status === 'saved' ? 'Saved' : 'Save'}
      </Button>
      <Button size="sm" disabled={busy !== null} onClick={() => void onDownload()}>
        {busy === 'download' ? <Spinner size="sm" className="mr-1.5" /> : failed ? <RotateCw className="mr-1.5 size-4" /> : <Download className="mr-1.5 size-4" />}
        {failed ? 'Retry' : 'Download'}
      </Button>
    </div>
  )
}
