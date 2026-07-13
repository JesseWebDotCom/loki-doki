// The Save / Save-offline / Download control for a storefront search result,
// shared by shelf tiles (variant="overlay", icon-only, floats over the cover),
// search cards and the preview page (variant="inline", labelled buttons). Three
// distinct actions, following the Videos/Music naming convention:
//   - "Save" (Bookmark): add to the library for online reading, no bytes pulled.
//   - "Save offline" (HardDriveDownload): the server downloads a copy so it can
//     be read later without streaming - same label as Videos' SaveOfflineButton.
//   - "Download" (Download, inline only): browser-download the raw file to this
//     device for use outside the app - same label as Videos' DownloadDialog.
// State is read from the shared library-index store so every instance for the
// same item stays in sync; mid-download entries carry a progress fraction.
// Preview-only sources (Google Books, Open Library) have no downloadable file,
// so this renders nothing for them. They keep just their "Preview" affordance.

import { useState, type MouseEvent } from 'react'
import { Bookmark, BookmarkCheck, Check, Clock, Download, HardDriveDownload, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { bookDeviceDownloadUrl, type BookSearchResult } from '@/lib/books/api'
import { useLibraryEntry, useMustRequestDownloads, saveResult, downloadResult, downloadSaved } from '@/lib/books/libraryIndex'

const PREVIEW_ONLY_SOURCES = new Set(['googlebooks', 'openlibrary'])

function triggerBrowserDownload(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

interface LibraryActionButtonProps {
  result: BookSearchResult
  variant?: 'overlay' | 'inline'
  className?: string
}

export function LibraryActionButton({ result, variant = 'inline', className }: LibraryActionButtonProps) {
  const entry = useLibraryEntry(result.source, result.sourceRef)
  const mustRequest = useMustRequestDownloads()
  const [busy, setBusy] = useState<null | 'save' | 'offline'>(null)

  if (PREVIEW_ONLY_SOURCES.has(result.source)) return null

  const status = entry?.status
  const downloading = status === 'pending' || status === 'downloading'
  const offline = status === 'ready'
  const failed = status === 'failed'
  const requested = status === 'requested'
  const pct = downloading && typeof entry?.progress === 'number' ? Math.round(entry.progress * 100) : null
  const downloadingLabel = pct !== null ? `Downloading ${pct}%` : 'Downloading...'

  const onSave = async () => {
    setBusy('save')
    try {
      await saveResult(result)
      toast.success('Saved to your library')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  // Kid-safe profiles turn a download into an approval request; surface that
  // distinctly instead of "Saving offline…".
  const onSaveOffline = async () => {
    setBusy('offline')
    try {
      const { requested: wasRequested } = entry
        ? await downloadSaved(result.source, result.sourceRef, entry.bookId)
        : await downloadResult(result)
      toast.success(wasRequested ? 'Requested, sent to an admin for approval' : 'Saving offline...')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  const onDeviceDownload = () => {
    triggerBrowserDownload(bookDeviceDownloadUrl(result))
    toast.success('The file saves to your device when ready')
  }

  // Overlay (shelf tile): compact icon buttons floating over the cover. Like a
  // Videos card, the tile only offers the quick in-app actions - "Download to
  // this device" lives on the inline variants (search card / preview page).
  if (variant === 'overlay') {
    const stop = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation() }
    const iconBtn = 'flex size-8 items-center justify-center rounded-full bg-black/60 text-white shadow-md backdrop-blur transition hover:bg-black/80 disabled:opacity-70'
    return (
      <div className={cn('absolute right-1.5 top-1.5 z-10 flex gap-1', className)} onClick={stop}>
        {offline ? (
          <span className={cn(iconBtn, 'bg-[var(--books-accent)]/90 cursor-default hover:bg-[var(--books-accent)]/90')} title="Saved offline">
            <Check className="size-4" />
          </span>
        ) : requested ? (
          <span className={cn(iconBtn, 'cursor-default')} title="Requested, awaiting admin approval"><Clock className="size-4" /></span>
        ) : downloading ? (
          <span className={cn(iconBtn, 'cursor-default')} title={downloadingLabel}><Spinner size="sm" className="text-white" /></span>
        ) : (
          <>
            <button type="button" className={iconBtn} disabled={busy !== null} title={status === 'saved' ? 'Saved' : 'Save to library'}
              onClick={(e) => { stop(e); if (status !== 'saved') void onSave() }}>
              {busy === 'save' ? <Spinner size="sm" className="text-white" /> : status === 'saved' ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
            </button>
            <button type="button" className={iconBtn} disabled={busy !== null} title={failed ? 'Retry saving offline' : 'Save offline'}
              onClick={(e) => { stop(e); void onSaveOffline() }}>
              {busy === 'offline' ? <Spinner size="sm" className="text-white" /> : failed ? <RotateCw className="size-4" /> : <HardDriveDownload className="size-4" />}
            </button>
          </>
        )}
      </div>
    )
  }

  // Inline (card / preview page): labelled buttons. "Download" (to this device)
  // is hidden for kid-safe profiles - the file bypasses the app, so there's no
  // approval to wait on.
  const deviceDownloadButton = !mustRequest && (
    <Button size="sm" variant="ghost" onClick={onDeviceDownload} title="Download the file to this device for use outside the app">
      <Download className="mr-1.5 size-4" />Download
    </Button>
  )

  if (offline) {
    return (
      <div className={cn('flex flex-wrap items-center gap-2', className)}>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--books-accent-soft)] px-3 py-1.5 text-sm font-medium text-[var(--books-accent-fg)]">
          <Check className="size-4" />Saved offline
        </span>
        {deviceDownloadButton}
      </div>
    )
  }
  if (requested) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground', className)}>
        <Clock className="size-4" />Requested, awaiting approval
      </span>
    )
  }
  if (downloading) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-sm text-muted-foreground', className)}>
        <Spinner size="sm" />{downloadingLabel}
      </span>
    )
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Button size="sm" variant="outline" disabled={busy !== null || status === 'saved'} onClick={() => void onSave()}>
        {busy === 'save' ? <Spinner size="sm" className="mr-1.5" /> : status === 'saved' ? <BookmarkCheck className="mr-1.5 size-4" /> : <Bookmark className="mr-1.5 size-4" />}
        {status === 'saved' ? 'Saved' : 'Save'}
      </Button>
      <Button size="sm" disabled={busy !== null} onClick={() => void onSaveOffline()} title="Save offline: this server downloads the file so you can read it later without streaming">
        {busy === 'offline' ? <Spinner size="sm" className="mr-1.5" /> : failed ? <RotateCw className="mr-1.5 size-4" /> : <HardDriveDownload className="mr-1.5 size-4" />}
        {failed ? 'Retry' : 'Save offline'}
      </Button>
      {deviceDownloadButton}
    </div>
  )
}
