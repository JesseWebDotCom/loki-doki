import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { PartyPopper, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { JamQueueSheet } from '@/components/music/JamQueueSheet'
import { useRadio } from '@/context/RadioContext'
import { useJam, useRefreshJam } from '@/hooks/useJam'
import { endJam, startJam } from '@/lib/together/api'
import { getDeviceId } from '@/lib/together/deviceIdentity'

// Family Jam: the one surface for starting, joining, and ending a jam. Rendered on the
// Music home page.
//   • no jam, station playing -> "Start a Family Jam" (seeds the shared queue with this
//     player's Up Next, so the party starts from what is already going)
//   • jam live, you are the host -> queue + End Jam
//   • jam live, someone else hosts -> "Join the Jam" (open the shared queue and add)
//
// Ending returns the host to their own queue: the engine keeps whatever it is playing
// and simply stops pulling shared items.

export function JamBanner() {
  const radio = useRadio()
  const { jam, isHostUser } = useJam()
  const refresh = useRefreshJam()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)

  const start = useMutation({
    mutationFn: () => {
      // Seed with this player's Up Next (the tail after the current track).
      const upNext = radio.queue.slice(radio.index + 1).map((t) => ({
        videoId: t.videoId, title: t.title, author: t.author, thumbnail: t.thumbnail,
      }))
      return startJam(getDeviceId(), upNext)
    },
    onSuccess: () => { toast.success('Family Jam started. Everyone can add songs now.'); refresh(); setSheetOpen(true) },
    onError: (e: Error) => toast.error(e.message),
  })

  const stop = useMutation({
    mutationFn: endJam,
    onSuccess: () => { toast.success('Jam ended. Back to your own queue.'); refresh() },
    onError: (e: Error) => toast.error(e.message),
  })

  // Nothing to offer when no jam is live and there is no station to share.
  if (!jam && !radio.active) return null

  return (
    <>
      <Card className="flex items-center gap-3 p-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-brand/12 text-brand">
          {jam ? <Users className="size-4" /> : <PartyPopper className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {jam ? (isHostUser ? 'Your Family Jam is live' : `${jam.hostName} started a Family Jam`) : 'Start a Family Jam'}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {jam
              ? `${jam.items.length} song${jam.items.length === 1 ? '' : 's'} in the shared queue`
              : 'Share your Up Next so everyone can add to it'}
          </p>
        </div>
        {jam ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSheetOpen(true)}>
              {isHostUser ? 'Open queue' : 'Join the Jam'}
            </Button>
            {isHostUser && (
              <Button variant="ghost" size="sm" onClick={() => setConfirmEnd(true)} disabled={stop.isPending}>
                {stop.isPending ? <Spinner size="sm" /> : 'End'}
              </Button>
            )}
          </div>
        ) : (
          <Button variant="secondary" size="sm" className="shrink-0" onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? <Spinner size="sm" /> : 'Start a Jam'}
          </Button>
        )}
      </Card>

      <JamQueueSheet open={sheetOpen} onOpenChange={setSheetOpen} />

      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title="End the Family Jam?"
        description="The shared queue closes and everyone stops adding to it. Whatever is playing keeps playing, and you go back to your own queue."
        confirmLabel="End jam"
        onConfirm={() => { stop.mutate(); setConfirmEnd(false) }}
      />
    </>
  )
}
