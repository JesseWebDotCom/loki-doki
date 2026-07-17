import { Timer } from 'lucide-react'
import { ToggleRow } from '@/components/shared/ToggleRow'
import { Card } from '@/components/ui/card'
import { usePodcastDspPrefs, useTimeSaved, fmtTimeSaved } from '@/hooks/usePodcastPlayerPrefs'

/** Podcast settings - Playback section: the global voice-boost / trim-silence toggles
 *  (per-show overrides live on each show's playback settings) and the running
 *  trim-silence "time saved" total. */
export function PodcastPlaybackSection() {
  const { voiceBoost, trimSilence, setVoiceBoost, setTrimSilence } = usePodcastDspPrefs()
  const timeSaved = useTimeSaved()

  return (
    <div className="space-y-3">
      <ToggleRow
        title="Voice boost"
        description="Broadcast-style speech leveling: quiet talkers come up, loud moments settle down. Great for listening in the car or kitchen."
        checked={voiceBoost}
        onCheckedChange={() => setVoiceBoost(!voiceBoost)}
      />
      <ToggleRow
        title="Trim silence"
        description="Skips through long pauses automatically by briefly speeding up playback, then easing back in when the conversation resumes."
        checked={trimSilence}
        onCheckedChange={() => setTrimSilence(!trimSilence)}
      />
      {timeSaved > 0 && (
        <Card className="flex items-center gap-3 p-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand/10 text-brand">
            <Timer className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold">Time saved: {fmtTimeSaved(timeSaved)}</p>
            <p className="text-xs text-muted-foreground">Total listening time trimmed by skipping silence.</p>
          </div>
        </Card>
      )}
    </div>
  )
}
