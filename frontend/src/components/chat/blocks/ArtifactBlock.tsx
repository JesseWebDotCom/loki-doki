import { Code2, FileText, Globe, PanelRightOpen } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { openArtifact } from '@/lib/canvas/artifactStore'
import type { ArtifactBlockData } from './types'

// Compact transcript card for a Canvas artifact the companion produced. The body
// itself lives in the Canvas pane (streamed there, not into the chat bubble), so
// this is just a labelled "Open in Canvas" affordance.
export function ArtifactBlock({ data }: { data: ArtifactBlockData }) {
  const Icon = data.artifactType === 'code' ? Code2 : data.artifactType === 'html' ? Globe : FileText
  const label = data.artifactType === 'code' ? 'Code' : data.artifactType === 'html' ? 'Web page' : 'Document'

  return (
    <Card variant="surface" className="mt-2 max-w-md overflow-hidden">
      <button
        type="button"
        onClick={() => void openArtifact(data.artifactId)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-card bg-primary/10 text-primary">
          <Icon className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{data.title}</p>
          <p className="truncate text-xs text-muted-foreground">{label} · Canvas</p>
        </div>
        <PanelRightOpen className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {data.preview && (
        <p className="line-clamp-2 border-t border-border bg-background/50 px-3 py-2 text-xs text-muted-foreground">
          {data.preview}
        </p>
      )}
      <div className="border-t border-border px-3 py-2">
        <Button size="sm" variant="outline" onClick={() => void openArtifact(data.artifactId)}>
          <PanelRightOpen className="size-3.5" /> Open in Canvas
        </Button>
      </div>
    </Card>
  )
}
