import { useEffect, useRef } from 'react'
import { useRadio } from '@/context/RadioContext'
import { useJam, useRefreshJam } from '@/hooks/useJam'
import { consumeJamItem } from '@/lib/together/api'

// Family Jam: the host half. While a jam is live and THIS session is the host device,
// the shared queue feeds the host's player: when local Up Next is about to run dry, the
// head of the shared queue is pulled into the radio engine (through the context's public
// enqueueTrack) and removed from the shared list, so everyone sees it leave as it starts
// playing.
//
// Items are pulled one at a time, and only when needed, so members keep the ability to
// reorder anything still waiting. Mounted once in App.tsx; renders nothing.

// Pull the next shared track once fewer than this many songs remain queued locally.
const LOW_WATER = 1

export function TogetherJamHost() {
  const radio = useRadio()
  const { jam, isHostDevice } = useJam()
  const refresh = useRefreshJam()

  // radio ticks every second; read it through a ref so the effect below can key on the
  // things that actually matter (the queue depth and the shared head).
  const radioRef = useRef(radio)
  radioRef.current = radio
  // Guards against firing a second pull while the first is still in flight (the poll
  // would otherwise re-see the same head and enqueue it twice).
  const pulling = useRef(false)

  const head = jam?.items[0] ?? null
  const upNext = radio.active ? radio.upNextCount() : 0

  useEffect(() => {
    if (!isHostDevice || !head || pulling.current) return
    if (!radioRef.current.active || upNext > LOW_WATER) return
    pulling.current = true
    void (async () => {
      try {
        // Claim the item server-side FIRST: if that fails the item simply stays shared
        // and the next poll retries. Enqueuing first would risk adding it locally twice
        // (once per poll) whenever the claim did not land.
        await consumeJamItem(head.id)
        radioRef.current.enqueueTrack({
          videoId: head.videoId,
          title: head.title,
          author: head.author,
          thumbnail: head.thumbnail,
        })
        refresh()
      } catch {
        /* still shared; retried on the next poll */
      } finally {
        pulling.current = false
      }
    })()
  }, [isHostDevice, head, upNext, refresh])

  return null
}
