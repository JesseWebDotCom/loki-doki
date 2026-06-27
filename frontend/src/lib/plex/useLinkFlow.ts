import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@/lib/toast'
import { startPlexPin, pollPlexPin, linkMyPlex, unlinkMyPlex, getMyPlex, type MyPlexStatus } from './api'

// Shared plex.tv PIN linking flow for the current user, used by both the inline connect card
// and the sticky banner so they behave identically. Polls the PIN until approved, then links.
export function usePlexLinkFlow() {
  const qc = useQueryClient()
  const [me, setMe] = useState<MyPlexStatus | null>(null)
  const [pin, setPin] = useState<{ code: string; linkUrl: string } | null>(null)
  const [linking, setLinking] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => setMe(await getMyPlex()), [])

  useEffect(() => {
    void refresh()
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [refresh])

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['plex-status'] })
    void qc.invalidateQueries({ queryKey: ['plex-rail'] })
  }, [qc])

  const begin = useCallback(async () => {
    setLinking(true)
    const p = await startPlexPin()
    if (!p) {
      setLinking(false)
      toast.error('Could not start Plex sign-in')
      return
    }
    // Don't auto-open the tab — it would cover the code before the user can read it. The card/
    // banner show the code + a plex.tv/link link the user clicks once they've noted the code.
    setPin({ code: p.code, linkUrl: p.linkUrl })
    timer.current = setInterval(async () => {
      const token = await pollPlexPin(p.id, p.clientId)
      if (!token) return
      if (timer.current) clearInterval(timer.current)
      setPin(null)
      const status = await linkMyPlex(token)
      setMe(status)
      setLinking(false)
      invalidate()
      toast.success(status.ok ? `Linked to ${status.serverName ?? 'Plex'}` : 'Linked your Plex account')
    }, 2000)
  }, [invalidate])

  const unlink = useCallback(async () => {
    await unlinkMyPlex()
    await refresh()
    invalidate()
    toast.success('Disconnected your Plex account')
  }, [refresh, invalidate])

  // Abort an in-progress link (close the modal): stop polling and clear the pin.
  const cancel = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    setPin(null)
    setLinking(false)
  }, [])

  return { me, pin, linking, begin, unlink, cancel }
}
