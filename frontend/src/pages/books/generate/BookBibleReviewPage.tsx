import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import {
  getBookProject, updateBookProjectBible, approveBookProjectBible, rejectBookProject, deleteBookProject,
  stageRouteForProject, type StoryBible, type ChapterOutlineEntry,
} from '@/lib/books/api'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label className="text-sm font-medium">{label}</label>{children}</div>
}

export function BookBibleReviewPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['book-project', id],
    queryFn: () => getBookProject(id!),
    enabled: !!id,
  })

  const [bible, setBible] = useState<StoryBible | null>(null)
  const [outline, setOutline] = useState<ChapterOutlineEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState(false)

  useEffect(() => {
    if (!data) return
    const editable = data.project.status === 'pending_bible_approval' || data.project.status === 'failed' || data.project.status === 'drafting_bible'
    if (!editable) { navigate(stageRouteForProject(data.project), { replace: true }); return }
    if (data.project.storyBible) setBible(data.project.storyBible)
    if (data.project.outline) setOutline(data.project.outline)
  }, [data, navigate])

  if (isLoading || !data) {
    return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>
  }

  const { project } = data

  if (project.status === 'failed' && !bible) {
    return (
      <div className="h-full overflow-y-auto">
        <PageContainer width="default" className="space-y-4 py-6">
          <PageHeader title="Story bible generation failed" className="pt-0 pb-0" />
          <p className="text-sm text-muted-foreground">{project.error || 'Something went wrong drafting the story bible.'}</p>
          <Button variant="outline" onClick={() => { void deleteBookProject(project.id).then(() => navigate('/books/generate/new')) }}>Try again</Button>
        </PageContainer>
      </div>
    )
  }

  if (!bible) {
    return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>
  }

  const save = async () => {
    setSaving(true)
    try {
      await updateBookProjectBible(project.id, { storyBible: bible, outline })
      await qc.invalidateQueries({ queryKey: ['book-project', id] })
      toast.success('Saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const approve = async () => {
    setApproving(true)
    try {
      await updateBookProjectBible(project.id, { storyBible: bible, outline })
      await approveBookProjectBible(project.id)
      navigate(`/books/generate/${project.id}/sample`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start writing')
      setApproving(false)
    }
  }

  const discard = async () => {
    await rejectBookProject(project.id).catch(() => {})
    navigate('/books/generate')
  }

  const updateChar = (i: number, patch: Partial<StoryBible['characters'][number]>) => {
    setBible((b) => b && { ...b, characters: b.characters.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) })
  }
  const updateChapter = (i: number, patch: Partial<ChapterOutlineEntry>) => {
    setOutline((o) => o.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="default" className="space-y-6 py-6 pb-24">
        <PageHeader title="Review your story bible" subtitle="Edit anything before AI writes a sample chapter — this shapes every chapter that follows." className="pt-0 pb-0" />

        <Card>
          <CardContent className="space-y-5 p-5">
            <Field label="Premise">
              <Textarea value={bible.premise} rows={3} onChange={(e) => setBible({ ...bible, premise: e.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Genre"><Input value={bible.genre} onChange={(e) => setBible({ ...bible, genre: e.target.value })} /></Field>
              <Field label="Tone"><Input value={bible.tone} onChange={(e) => setBible({ ...bible, tone: e.target.value })} /></Field>
              <Field label="POV"><Input value={bible.pov} onChange={(e) => setBible({ ...bible, pov: e.target.value })} /></Field>
            </div>
            <Field label="Setting"><Input value={bible.setting} onChange={(e) => setBible({ ...bible, setting: e.target.value })} /></Field>
          </CardContent>
        </Card>

        <div>
          <SectionHeader title="Characters" className="mt-2 mb-3" />
          <div className="space-y-3">
            {bible.characters.map((c, i) => (
              <Card key={i}>
                <CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[1fr_1fr_2fr_auto]">
                  <Input value={c.name} placeholder="Name" onChange={(e) => updateChar(i, { name: e.target.value })} />
                  <Input value={c.role} placeholder="Role" onChange={(e) => updateChar(i, { role: e.target.value })} />
                  <Input value={c.traits} placeholder="Traits" onChange={(e) => updateChar(i, { traits: e.target.value })} />
                  <Button variant="ghost" size="icon" onClick={() => setBible({ ...bible, characters: bible.characters.filter((_, idx) => idx !== i) })}>
                    <Trash2 className="size-4" />
                  </Button>
                </CardContent>
              </Card>
            ))}
            <Button variant="outline" size="sm" onClick={() => setBible({ ...bible, characters: [...bible.characters, { name: '', role: 'supporting', traits: '' }] })}>
              <Plus className="size-4" /> Add character
            </Button>
          </div>
        </div>

        <div>
          <SectionHeader title={`Chapter outline (${outline.length})`} className="mt-2 mb-3" />
          <div className="space-y-2">
            {outline.map((ch, i) => (
              <Card key={i}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">Chapter {i + 1} · ~{ch.targetWords} words</div>
                  <Input value={ch.title} placeholder="Chapter title" onChange={(e) => updateChapter(i, { title: e.target.value })} />
                  <Textarea value={ch.summary} rows={2} placeholder="What happens in this chapter" onChange={(e) => updateChapter(i, { summary: e.target.value })} />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button size="lg" onClick={() => void approve()} disabled={approving || saving}>
            {approving ? <><Spinner size="sm" /> Starting…</> : 'Approve & write sample chapter'}
          </Button>
          <Button variant="outline" onClick={() => void save()} disabled={saving || approving}>
            {saving ? <><Spinner size="sm" /> Saving…</> : 'Save edits'}
          </Button>
          <Button variant="ghost" onClick={() => void discard()} disabled={approving || saving}>Discard</Button>
        </div>
      </PageContainer>
    </div>
  )
}
