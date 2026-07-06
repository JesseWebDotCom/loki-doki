import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Film, Plus, Sparkles, Trash2 } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { createStudioProject, deleteStudioProject, listStudioProjects } from '@/lib/videos/studioApi'

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Create home: edit projects (timeline editor) or generate clips with AI (the former
// standalone Video app, now living at /videos/create/generate).
export function StudioProjectsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null)

  const { data, isLoading } = useQuery({ queryKey: ['studio-projects'], queryFn: listStudioProjects })
  const projects = data?.projects ?? []

  const createMutation = useMutation({
    mutationFn: () => createStudioProject(),
    onSuccess: ({ id }) => navigate(`/videos/create/${id}`),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not create a project'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteStudioProject(id),
    onSuccess: () => {
      toast.success('Project deleted')
      void qc.invalidateQueries({ queryKey: ['studio-projects'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not delete'),
  })

  return (
    <PageContainer width="wide" className="py-6">
      <PageHeader subtitle="Cut, join, and export your videos, or generate new clips with AI." />

      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card variant="interactive" className="flex items-center gap-3 p-4" onClick={() => createMutation.mutate()}>
          {createMutation.isPending ? <Spinner size="sm" /> : <Plus className="size-5 text-[var(--yt-accent-fg)]" />}
          <div>
            <p className="text-sm font-semibold">New project</p>
            <p className="text-xs text-muted-foreground">Trim, join & export from your saved videos</p>
          </div>
        </Card>
        <Link to="/videos/create/generate">
          <Card variant="interactive" className="flex items-center gap-3 p-4">
            <Sparkles className="size-5 text-[var(--yt-accent-fg)]" />
            <div>
              <p className="text-sm font-semibold">Generate a clip</p>
              <p className="text-xs text-muted-foreground">Text to video & image to video with AI</p>
            </div>
          </Card>
        </Link>
      </div>

      <SectionHeader title="Projects" className="mb-4" />
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Film className="mb-3 size-10 opacity-30" />
          <p className="text-sm font-medium">No projects yet</p>
          <p className="mt-1 text-xs">Start one and pull in anything from your library.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <Card key={p.id} variant="interactive" className="group p-4" onClick={() => navigate(`/videos/create/${p.id}`)}>
              <div className="flex items-start gap-3">
                <Clapperboard className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.durationSec > 0 ? `${fmtDur(p.durationSec)} · ` : ''}updated {new Date(p.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  size="sm" variant="ghost"
                  className="size-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete({ id: p.id, name: p.name }) }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(v) => { if (!v) setConfirmDelete(null) }}
        title="Delete project?"
        description={`"${confirmDelete?.name}" will be removed. Exports already in your media bin stay.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (confirmDelete) deleteMutation.mutate(confirmDelete.id); setConfirmDelete(null) }}
      />
    </PageContainer>
  )
}
