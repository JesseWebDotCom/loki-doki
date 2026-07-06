// Media bin: everything the user can cut (offline YouTube, clips, hub saves, uploads,
// exports), newest first. Click adds the item to the end of the timeline.

import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Film, Music2, Plus, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import { listStudioBin, uploadStudioMedia, type StudioBinItem } from '@/lib/videos/studioApi'
import { useEditor } from '@/components/videostudio/editorStore'

function fmtDur(sec: number | null): string {
  if (sec == null || sec <= 0) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function BinRow({ item, onAdd }: { item: StudioBinItem; onAdd: () => void }) {
  return (
    // design-ok(hand-styled-button): media-bin row is a full-width list row, not a button control
    <button
      type="button"
      onClick={onAdd}
      className="group flex w-full items-center gap-2.5 rounded-control p-1.5 text-left transition-colors hover:bg-accent/60"
      title="Add to timeline"
    >
      <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-control bg-muted">
        {item.thumbUrl ? (
          <img src={item.thumbUrl.startsWith('/api/') ? item.thumbUrl : proxyImg(item.thumbUrl)} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center">
            {item.kind === 'audio' ? <Music2 className="size-4 text-muted-foreground/60" /> : <Film className="size-4 text-muted-foreground/60" />}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{item.title}</p>
        <p className="text-[10px] capitalize text-muted-foreground">{item.origin}{item.durationSec ? ` · ${fmtDur(item.durationSec)}` : ''}</p>
      </div>
      <Plus className="mr-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

export function MediaBinPanel() {
  const qc = useQueryClient()
  const { appendClip } = useEditor()
  const fileRef = useRef<HTMLInputElement>(null)

  const { data, isLoading } = useQuery({ queryKey: ['studio-bin'], queryFn: listStudioBin })
  const items = (data?.items ?? []).filter((i) => i.kind === 'video')   // v1a: video-only timeline

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadStudioMedia(file),
    onSuccess: () => {
      toast.success('Added to your media')
      void qc.invalidateQueries({ queryKey: ['studio-bin'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Upload failed'),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-overline text-muted-foreground/70">Media</p>
        <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs"
          disabled={uploadMutation.isPending}
          onClick={() => fileRef.current?.click()}>
          {uploadMutation.isPending ? <Spinner size="sm" /> : <Upload className="size-3.5" />} Upload
        </Button>
        <input ref={fileRef} type="file" accept="video/*,.mkv,.webm" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadMutation.mutate(f); e.target.value = '' }} />
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner size="sm" /></div>
        ) : items.length === 0 ? (
          <p className="px-1 py-6 text-xs text-muted-foreground">
            Nothing to edit yet. Save videos offline anywhere in Videos, or upload a file.
          </p>
        ) : (
          items.map((item) => (
            <BinRow key={item.assetId} item={item} onAdd={() => appendClip(item.assetId, item.durationSec)} />
          ))
        )}
      </div>
    </div>
  )
}
