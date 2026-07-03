import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { createBookProject, stageRouteForProject } from '@/lib/books/api'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  )
}

export function BookCreateBriefPage() {
  const navigate = useNavigate()
  const [premise, setPremise] = useState('')
  const [genre, setGenre] = useState('')
  const [tone, setTone] = useState('')
  const [pov, setPov] = useState('')
  const [title, setTitle] = useState('')
  const [chapterCount, setChapterCount] = useState(10)
  const [wordsPerChapter, setWordsPerChapter] = useState(1500)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!premise.trim()) { toast.error('A premise is required'); return }
    setSubmitting(true)
    try {
      const project = await createBookProject({
        premise: premise.trim(), genre: genre.trim() || undefined, tone: tone.trim() || undefined,
        pov: pov.trim() || undefined, title: title.trim() || undefined, chapterCount, wordsPerChapter,
      })
      if (project.status === 'failed') {
        toast.error(project.error || 'Story bible generation failed — try again')
        setSubmitting(false)
        return
      }
      navigate(stageRouteForProject(project))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start this book')
      setSubmitting(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="default" className="space-y-6 py-6 pb-24">
        <PageHeader title="Write a book" subtitle="Describe your idea — AI will draft a story bible and chapter outline for you to review first." className="pt-0 pb-0" />

        <Card>
          <CardContent className="space-y-5 p-5">
            <Field label="Premise">
              <Textarea value={premise} onChange={(e) => setPremise(e.target.value)} rows={4} disabled={submitting}
                placeholder="A retired lighthouse keeper discovers a message in a bottle that leads her back to a mystery from her youth…" />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Genre (optional)"><Input value={genre} onChange={(e) => setGenre(e.target.value)} disabled={submitting} placeholder="Mystery" /></Field>
              <Field label="Tone (optional)"><Input value={tone} onChange={(e) => setTone(e.target.value)} disabled={submitting} placeholder="Wistful, slow-burn" /></Field>
              <Field label="POV (optional)"><Input value={pov} onChange={(e) => setPov(e.target.value)} disabled={submitting} placeholder="Third person limited" /></Field>
            </div>
            <Field label="Title (optional — AI names it if left blank)">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={submitting} placeholder="" />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Chapters">
                <Input type="number" min={3} max={30} value={chapterCount} disabled={submitting}
                  onChange={(e) => setChapterCount(Math.max(3, Math.min(30, parseInt(e.target.value, 10) || 10)))} />
              </Field>
              <Field label="Words per chapter">
                <Input type="number" min={500} max={3000} step={100} value={wordsPerChapter} disabled={submitting}
                  onChange={(e) => setWordsPerChapter(Math.max(500, Math.min(3000, parseInt(e.target.value, 10) || 1500)))} />
              </Field>
            </div>
            <Button size="lg" className="w-full" disabled={submitting || !premise.trim()} onClick={() => void submit()}>
              {submitting ? <><Spinner size="sm" /> Drafting story bible…</> : 'Draft story bible'}
            </Button>
          </CardContent>
        </Card>
      </PageContainer>
    </div>
  )
}
