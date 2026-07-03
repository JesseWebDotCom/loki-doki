import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { RotateCw } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import {
  getBookProjectStatus, getBookProjectChapter, approveBookProjectSample, regenerateBookProjectSample, rejectBookProject,
  type BookProjectChapterDetail,
} from '@/lib/books/api'

const POLL_MS = 3000

export function BookSampleApprovalPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<'loading' | 'writing' | 'ready' | 'failed'>('loading')
  const [chapter, setChapter] = useState<BookProjectChapterDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current) }, [])

  const checkOnce = useCallback(async () => {
    const status = await getBookProjectStatus(id)
    if (!status) { setPhase('failed'); return }
    if (status.status === 'pending_bible_approval' || status.status === 'drafting_bible') {
      navigate(`/books/generate/${id}/bible`, { replace: true }); return
    }
    if (status.status === 'generating' || status.status === 'completed') {
      navigate(`/books/generate/${id}/progress`, { replace: true }); return
    }
    if (status.status === 'failed') { setPhase('failed'); return }
    if (status.status === 'pending_sample_approval') {
      const ch = await getBookProjectChapter(id, 0)
      setChapter(ch)
      setPhase('ready')
      return
    }
    // pending_sample — still writing, poll again
    setPhase('writing')
    pollRef.current = setTimeout(() => { void checkOnce() }, POLL_MS)
  }, [id, navigate])

  useEffect(() => { void checkOnce() }, [checkOnce])

  const approve = async () => {
    setBusy(true)
    try {
      const res = await approveBookProjectSample(id)
      if (res.committed) {
        toast.success('Your book is ready')
        const status = await getBookProjectStatus(id)
        navigate(status?.resultBookId ? `/books/detail/${status.resultBookId}` : '/books/generate')
      } else {
        navigate(`/books/generate/${id}/progress`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not continue writing')
      setBusy(false)
    }
  }

  const regenerate = async () => {
    setBusy(true)
    try {
      await regenerateBookProjectSample(id)
      setPhase('writing')
      setChapter(null)
      void checkOnce()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not regenerate the sample')
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    await rejectBookProject(id).catch(() => {})
    navigate('/books/generate')
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="default" className="space-y-6 py-6 pb-24">
        <PageHeader title="Sample chapter" subtitle="Review chapter one before AI writes the rest of the book in this voice." className="pt-0 pb-0" />

        {phase === 'loading' || phase === 'writing' ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20">
            <Spinner size="lg" />
            <p className="text-sm text-muted-foreground">Writing the sample chapter…</p>
          </div>
        ) : phase === 'failed' ? (
          <div className="space-y-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">The sample chapter failed to generate.</p>
            <Button variant="outline" onClick={() => void regenerate()} disabled={busy}><RotateCw className="size-4" /> Try again</Button>
          </div>
        ) : (
          <>
            <Card>
              <CardContent className="prose prose-sm max-w-none whitespace-pre-wrap p-6 text-sm leading-relaxed">
                <h2 className="mb-4 text-lg font-semibold">{chapter?.title || 'Chapter 1'}</h2>
                {chapter?.draftText || 'No text generated.'}
              </CardContent>
            </Card>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" onClick={() => void approve()} disabled={busy}>
                {busy ? <><Spinner size="sm" /> Starting…</> : 'Approve & write the rest of the book'}
              </Button>
              <Button variant="outline" onClick={() => void regenerate()} disabled={busy}><RotateCw className="size-4" /> Regenerate sample</Button>
              <Button variant="ghost" onClick={() => void reject()} disabled={busy}>Reject</Button>
            </div>
          </>
        )}
      </PageContainer>
    </div>
  )
}
