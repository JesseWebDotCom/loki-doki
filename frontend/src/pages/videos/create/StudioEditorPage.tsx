import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Clapperboard, Redo2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { getStudioProject } from '@/lib/videos/studioApi'
import { StudioEditorProvider, useEditor } from '@/components/videostudio/editorStore'
import { PreviewPlayer } from '@/components/videostudio/PreviewPlayer'
import { TimelinePanel } from '@/components/videostudio/TimelinePanel'
import { MediaBinPanel } from '@/components/videostudio/MediaBinPanel'
import { ExportDialog } from '@/components/videostudio/ExportDialog'

function EditorChrome({ projectId, name }: { projectId: string; name: string }) {
  const { state, undo, redo } = useEditor()
  const [exportOpen, setExportOpen] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {/* Header row. */}
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost" className="gap-1.5">
          <Link to="/videos/mine"><ArrowLeft className="size-4" /> Mine</Link>
        </Button>
        <p className="truncate text-sm font-semibold">{name}</p>
        <span className="text-xs text-muted-foreground">{state.dirty ? 'Saving…' : 'Saved'}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="size-8 p-0" title="Undo (⌘Z)" disabled={state.past.length === 0} onClick={undo}>
            <Undo2 className="size-4" />
          </Button>
          <Button size="sm" variant="outline" className="size-8 p-0" title="Redo (⇧⌘Z)" disabled={state.future.length === 0} onClick={redo}>
            <Redo2 className="size-4" />
          </Button>
          <Button size="sm" className="gap-1.5" disabled={state.edl.video.length === 0} onClick={() => setExportOpen(true)}>
            <Clapperboard className="size-4" /> Export
          </Button>
        </div>
      </div>

      {/* Bin | preview. */}
      <div className="flex min-h-0 flex-1 gap-3">
        <Card variant="flat" className="hidden w-64 shrink-0 p-3 md:block">
          <MediaBinPanel />
        </Card>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <PreviewPlayer />
        </div>
      </div>

      {/* Timeline. */}
      <TimelinePanel />

      <ExportDialog projectId={projectId} open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  )
}

export function StudioEditorPage() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const { data, isLoading, error } = useQuery({
    queryKey: ['studio-project', projectId],
    queryFn: () => getStudioProject(projectId),
    enabled: !!projectId,
    staleTime: Infinity,          // the editor owns the document once loaded
    refetchOnWindowFocus: false,
  })

  if (isLoading) {
    return <div className="flex h-full flex-1 items-center justify-center"><Spinner /></div>
  }
  if (error || !data?.project) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : 'Project not found.'}
      </div>
    )
  }

  return (
    <StudioEditorProvider projectId={projectId} initial={data.project.edl}>
      <EditorChrome projectId={projectId} name={data.project.name} />
    </StudioEditorProvider>
  )
}
