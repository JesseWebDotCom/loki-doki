import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useRadio } from '@/context/RadioContext'
import { useLiveRadio } from '@/context/LiveRadioContext'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { useFamilyAudio } from '@/hooks/useFamilyAudio'

// Family audio: the cooperative client half of the guardrails. The server refuses
// blocked/over-budget playback at the queue/resolve/stream endpoints; this component
// makes the experience graceful on top of that:
//   • stops the music/live-radio/podcast players when the gate closes mid-listen,
//   • fires the one-time "5 minutes left" warning toast,
//   • clamps every player's volume to the profile's cap.
// Mounted once in App.tsx inside the player providers; renders nothing.

export function FamilyAudioGuard() {
  const { data: status } = useFamilyAudio()
  const radio = useRadio()
  const live = useLiveRadio()
  const pod = usePodcastPlayback()

  const anythingPlaying = radio.active || live.active || (!!pod.track && pod.playing)

  // Graceful stop when the gate closes (budget exhausted or quiet hours started).
  const stoppedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!status || status.allowed) { stoppedForRef.current = null; return }
    if (!anythingPlaying) return
    const key = `${status.reason}`
    if (stoppedForRef.current === key) return
    stoppedForRef.current = key
    if (radio.active) radio.stop()
    if (live.active) live.stop()
    if (pod.track) pod.pause()
    toast.info(
      status.reason === 'quiet_hours' ? 'Quiet hours' : 'Audio time is done for today',
      {
        description: status.reason === 'quiet_hours'
          ? 'Audio is paused for the night. See you tomorrow!'
          : 'Playback will pick right back up tomorrow.',
        duration: 8000,
      },
    )
  }, [status, anythingPlaying, radio, live, pod])

  // One warning toast when 5 minutes (or less) remain while something is playing.
  const warnedDayRef = useRef<string | null>(null)
  useEffect(() => {
    const remaining = status?.remainingMinutes
    if (remaining == null || !status?.allowed) return
    if (!anythingPlaying) return
    const dayKey = new Date().toDateString()
    if (remaining > 5) {
      if (warnedDayRef.current === dayKey) warnedDayRef.current = null
      return
    }
    if (warnedDayRef.current === dayKey) return
    warnedDayRef.current = dayKey
    toast.warning('5 minutes of audio time left today', { duration: 8000 })
  }, [status, anythingPlaying])

  // Volume cap: clamp the engines whenever their volume rises past the cap.
  const cap = status?.maxVolumePercent
  useEffect(() => {
    if (cap == null) return
    const capV = cap / 100
    if (radio.volume > capV) radio.setVolume(capV)
  }, [cap, radio, radio.volume])
  useEffect(() => {
    if (cap == null) return
    const capV = cap / 100
    if (live.volume > capV) live.setVolume(capV)
  }, [cap, live, live.volume])
  useEffect(() => {
    if (cap == null) return
    const capV = cap / 100
    if (pod.volume > capV) pod.setVolume(capV)
  }, [cap, pod, pod.volume])

  return null
}
