import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Sparkles, GitBranch, Wand2, Clock } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { listBookProjects, stageRouteForProject, type BookProjectStatus } from '@/lib/books/api'

const STATUS_LABEL: Partial<Record<BookProjectStatus, string>> = {
  drafting_bible: 'Planning…',
  pending_bible_approval: 'Awaiting your review',
  pending_sample: 'Writing sample chapter…',
  pending_sample_approval: 'Sample ready for review',
  generating: 'Writing…',
  failed: 'Failed',
}

export function BookCreateEntryPage() {
  const navigate = useNavigate()
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['book-projects'],
    queryFn: listBookProjects,
  })
  const inProgress = projects.filter((p) => p.status !== 'completed' && p.status !== 'cancelled')

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="space-y-9 py-6 pb-24">
        <PageHeader title="Create with AI" subtitle="Write a brand new book, or continue and reshape ones already in your library." className="pt-0 pb-0" />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card variant="interactive" onClick={() => navigate('/books/generate/new')}>
            <CardHeader>
              <Sparkles className="mb-1 size-6 text-[var(--books-accent)]" />
              <CardTitle>Write from scratch</CardTitle>
              <CardDescription>Give a premise and AI drafts a full book, chapter by chapter, with your approval along the way.</CardDescription>
            </CardHeader>
          </Card>
          <Card variant="dashed" className="opacity-60">
            <CardHeader>
              <GitBranch className="mb-1 size-6 text-muted-foreground" />
              <CardTitle className="flex items-center gap-2">Continue a book <Badge variant="secondary" className="text-xs">Coming soon</Badge></CardTitle>
              <CardDescription>Write a prequel, sequel, or side story using an existing book's characters and voice.</CardDescription>
            </CardHeader>
          </Card>
          <Card variant="dashed" className="opacity-60">
            <CardHeader>
              <Wand2 className="mb-1 size-6 text-muted-foreground" />
              <CardTitle className="flex items-center gap-2">Reshape a book <Badge variant="secondary" className="text-xs">Coming soon</Badge></CardTitle>
              <CardDescription>Rewrite the ending, change the tone, or shift the point of view on a book you already have.</CardDescription>
            </CardHeader>
          </Card>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner size="lg" /></div>
        ) : inProgress.length > 0 ? (
          <div>
            <SectionHeader title="In progress" className="mt-2 mb-4" />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {inProgress.map((p) => (
                <Card key={p.id} variant="interactive" onClick={() => navigate(stageRouteForProject(p))}>
                  <CardContent className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.title || p.prompt?.premise?.slice(0, 60) || 'Untitled book'}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="size-3" /> {STATUS_LABEL[p.status] ?? p.status}
                      </p>
                    </div>
                    {(p.status === 'drafting_bible' || p.status === 'pending_sample' || p.status === 'generating') && <Spinner size="sm" />}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ) : null}
      </PageContainer>
    </div>
  )
}
