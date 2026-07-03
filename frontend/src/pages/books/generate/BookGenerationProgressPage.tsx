import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { getBookProjectStatus, type BookProjectStatusResponse } from '@/lib/books/api'

const POLL_MS = 3000

export function BookGenerationProgressPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [status, setStatus] = useState<BookProjectStatusResponse | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current) }, [])

  const check = useCallback(async () => {
    const s = await getBookProjectStatus(id)
    if (!s) return
    setStatus(s)
    if (s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled') return
    pollRef.current = setTimeout(() => { void check() }, POLL_MS)
  }, [id])

  useEffect(() => { void check() }, [check])

  const total = status?.totalChapters ?? 0
  const done = Math.min(status?.currentChapterIdx ?? 0, total)
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="narrow" className="space-y-6 py-6 pb-24">
        <PageHeader title="Writing your book" subtitle="This runs in the background — feel free to leave this page." className="pt-0 pb-0" />

        {status?.status === 'completed' ? (
          <div className="flex flex-col items-center gap-4 py-16 text-center">
            <BookOpen className="size-12 text-[var(--books-accent)]" />
            <p className="text-lg font-medium">Your book is ready</p>
            <Button size="lg" onClick={() => navigate(status.resultBookId ? `/books/detail/${status.resultBookId}` : '/books/generate')}>
              View your book
            </Button>
          </div>
        ) : status?.status === 'failed' ? (
          <div className="space-y-4 py-16 text-center">
            <p className="text-sm text-muted-foreground">{status.error || 'Book generation failed.'}</p>
            <Button variant="outline" onClick={() => navigate('/books/generate')}>Back</Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-16">
            <Spinner size="lg" />
            <p className="text-sm text-muted-foreground">
              {total > 0 ? `Writing chapter ${Math.min(done + 1, total)} of ${total}…` : 'Getting started…'}
            </p>
            {total > 0 && (
              <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-[var(--books-accent)] transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
            {status?.job?.progress?.note && <p className="text-xs text-muted-foreground">{status.job.progress.note}</p>}
          </div>
        )}
      </PageContainer>
    </div>
  )
}
