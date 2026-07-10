import { StudioTutorials } from '@/components/music/studio/StudioTutorials'
import { useStudioEngine } from '@/context/MusicStudioEngineContext'

export function MusicStudioTutorialsPage() {
  const { trackId, track } = useStudioEngine()
  if (!track) return null
  return <StudioTutorials trackId={trackId} artist={track.artist} title={track.title} />
}
