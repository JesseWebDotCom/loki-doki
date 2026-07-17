import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Rewind, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { getCatchUp, type VideoSource } from '@/lib/videos/api'

// "Catch me up": Prime Video's X-Ray Recaps, without the account. Shown only when you're
// resuming a video well past the start, it recaps everything BEFORE your resume point.
// The spoiler safety is structural, not a prompt plea: the server only ever hands the
// model the transcript before that second (see lib/videos/aiExtras.ts).
export function CatchMeUpCard({ source, videoId, resumeSec }: {
  source: VideoSource | 'youtube'
  videoId: string
  /** Where playback is resuming. The recap covers up to here and no further. */
  resumeSec: number
}) {
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['videos-catch-up', source, videoId, Math.floor(resumeSec / 60)],
    queryFn: () => getCatchUp(source, videoId, resumeSec),
    enabled: open,
    staleTime: 60 * 60_000,
  })

  if (dismissed) return null

  if (!open) {
    return (
      <Card className="flex items-center gap-3 p-3">
        <Rewind className="size-4 shrink-0 text-brand" />
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          You're picking this up partway through.
        </p>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="shrink-0">
          Catch me up
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setDismissed(true)} aria-label="Dismiss"
          className="shrink-0 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </Button>
      </Card>
    )
  }

  return (
    <Card className="p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <Rewind className="size-3.5 shrink-0 text-brand" />
        <p className="flex-1 text-xs font-semibold">The story so far</p>
        <Button variant="ghost" size="icon-sm" onClick={() => setDismissed(true)} aria-label="Dismiss"
          className="shrink-0 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </Button>
      </div>
      {isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" /> Reading back over it…</p>
      ) : data?.recap ? (
        <p className="text-xs leading-relaxed">{data.recap}</p>
      ) : (
        <p className="text-xs text-muted-foreground">There's no transcript for this one, so I can't recap it.</p>
      )}
    </Card>
  )
}
