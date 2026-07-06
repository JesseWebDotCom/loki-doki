import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Film, Plus, Sparkles, Trash2, Video } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import {
  createStudioProject, deleteStudioProject, listStudioBin, listStudioProjects,
  studioStreamUrl, type StudioBinItem,
} from '@/lib/videos/studioApi'

function fmtDur(sec: number | null): string {
  if (sec == null || sec <= 0) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** My Videos: everything that's yours (exports, uploads, recordings, AI generations)
 *  plus your edit projects, with the create actions living right here. */
export function MyVideosPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null)
  const [playing, setPlaying] = useState<StudioBinItem | null>(null)

  const { data, isLoading } = useQuery({ queryKey: ['studio-projects'], queryFn: listStudioProjects })
  const projects = data?.projects ?? []

  const { data: binData } = useQuery({ queryKey: ['studio-bin'], queryFn: listStudioBin })
  const mine = (binData?.items ?? []).filter((i) =>
    i.kind === 'video' && ['export', 'upload', 'recording', 'generated'].includes(i.origin))

  const createMutation = useMutation({
    mutationFn: () => createStudioProject(),
    onSuccess: ({ id }) => navigate(`/videos/mine/${id}`),
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
    <PageContainer width="wide" className="pt-1 pb-8">
      <PageHeader
        title="Mine"
        icon={Video}
        // design-ok(hex-in-tsx): Mine identity tile gradient
        gradient="linear-gradient(135deg,#312e81,#7c3aed)"
        eyebrow="Videos"
        subtitle="Your exports, uploads & AI clips, plus the projects that make them."
        className="pt-4 pb-4"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
              {createMutation.isPending ? <Spinner size="sm" /> : <Plus className="size-4" />} New project
            </Button>
            <Button asChild size="sm" className="gap-1.5">
              <Link to="/videos/mine/generate"><Sparkles className="size-4" /> Generate a clip</Link>
            </Button>
          </div>
        }
      />

      {mine.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="Your videos" className="mb-4" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4">
            {mine.map((item) => (
              <button key={item.assetId} type="button" className="group flex flex-col gap-2 text-left" onClick={() => setPlaying(item)}>
                <div className="relative aspect-video w-full overflow-hidden rounded-card bg-muted">
                  {item.thumbUrl ? (
                    <img src={item.thumbUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
                  ) : (
                    <div className="flex size-full items-center justify-center"><Film className="size-8 text-muted-foreground/50" /></div>
                  )}
                  {item.durationSec ? (
                    <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{fmtDur(item.durationSec)}</span>
                  ) : null}
                </div>
                <div className="min-w-0">
                  <p className="line-clamp-2 text-sm font-semibold leading-snug">{item.title}</p>
                  <p className="mt-0.5 text-xs capitalize text-muted-foreground">{item.origin}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

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
            <Card key={p.id} variant="interactive" className="group p-4" onClick={() => navigate(`/videos/mine/${p.id}`)}>
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
        description={`"${confirmDelete?.name}" will be removed. Videos already in Mine stay.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (confirmDelete) deleteMutation.mutate(confirmDelete.id); setConfirmDelete(null) }}
      />

      <Dialog open={!!playing} onOpenChange={(v) => { if (!v) setPlaying(null) }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle className="truncate">{playing?.title}</DialogTitle></DialogHeader>
          {playing && (
            <video src={studioStreamUrl(playing.assetId)} controls autoPlay playsInline className="aspect-video w-full rounded-card bg-black" />
          )}
        </DialogContent>
      </Dialog>
    </PageContainer>
  )
}
