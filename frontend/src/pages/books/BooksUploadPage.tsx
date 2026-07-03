import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Upload, FileUp } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { uploadBookFile } from '@/lib/books/api'

const SUPPORTED_EXT = /\.(epub|pdf|cbz|cbr|mp3|m4a|m4b|aac)$/i

export function BooksUploadPage() {
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const handleFiles = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    if (!SUPPORTED_EXT.test(file.name)) {
      toast.error('Supported: EPUB, PDF, CBZ, CBR, MP3, M4A, M4B, AAC')
      return
    }
    setUploading(true)
    try {
      const { bookId } = await uploadBookFile(file)
      await qc.invalidateQueries({ queryKey: ['books-library'] })
      toast.success('Book added to your library')
      navigate(`/books/detail/${bookId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [navigate, qc])

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="pb-16">
        <PageHeader subtitle="EPUB, PDF, CBZ, CBR, and audiobook files: everything stays fully offline." />
        <div className="flex flex-col items-center justify-center gap-4 py-8">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); void handleFiles(e.dataTransfer.files) }}
            onClick={() => inputRef.current?.click()}
            className={cn(
              'flex w-full max-w-md cursor-pointer flex-col items-center gap-3 rounded-card border-2 border-dashed px-8 py-16 text-center transition-colors',
              dragging ? 'border-brand bg-brand/5' : 'border-border hover:border-border/80 hover:bg-accent/30',
            )}
          >
            {uploading ? <Spinner size="lg" /> : <FileUp className="size-10 text-muted-foreground/50" />}
            <p className="text-sm font-medium">{uploading ? 'Uploading…' : 'Drop a book or audiobook file here'}</p>
            <p className="text-xs text-muted-foreground">or click to browse: EPUB, PDF, CBZ, CBR, MP3, M4A, M4B, AAC</p>
            <input ref={inputRef} type="file" accept=".epub,.pdf,.cbz,.cbr,.mp3,.m4a,.m4b,.aac" className="hidden" disabled={uploading}
              onChange={(e) => void handleFiles(e.target.files)} />
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Upload className="size-3.5" /> Uploaded books are added to your library and stay entirely offline.
          </p>
        </div>
      </PageContainer>
    </div>
  )
}
