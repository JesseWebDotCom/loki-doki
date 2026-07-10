import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { useRadio } from '@/context/RadioContext'
import { usePlayerOverlay } from '@/context/PlayerOverlayContext'

// Deep-link shim: NowPlayingOverlay is THE full music player (one player UI instead of a
// near-duplicate page + overlay, which also let the mini bar render the same track twice
// underneath this route). The /music/now-playing URL survives for its ~16 existing callers
// (station cards, controller displays, browser-session restore, Plex hooks): landing here
// raises the overlay over /music. Fullscreen promotion is skipped by the browser outside a
// click gesture; PlayerOverlayContext already tolerates that and the overlay still covers
// the viewport.
export function NowPlayingPage() {
  const radio = useRadio()
  const navigate = useNavigate()
  const { openPlayer } = usePlayerOverlay()

  useEffect(() => {
    if (radio.active) {
      openPlayer()
      navigate('/music', { replace: true })
    }
    // Run once on mount: this route is only ever an entry point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (radio.active) return null
  return (
    <PageContainer width="wide">
      <PageHeader plain title="Now Playing" subtitle="Start a station to see lyrics, info, and what's up next." />
    </PageContainer>
  )
}
