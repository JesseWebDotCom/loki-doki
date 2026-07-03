// Lists the speakers a narration session detected, with a per-speaker voice picker
// (curated roster, same one narration/voicePool.ts assigns from server-side).
// Shown before/while "Cast voices" playback so the user can override who sounds
// like what before committing, or mid-playback for turns not yet queued.

import { Play } from 'lucide-react'
import { RichOptionSelect, type RichOptionGroup } from '@/components/shared/RichOptionSelect'
import { voiceMeta, KOKORO_VOICE_IDS } from '@/lib/companions/voiceCatalog'
import { speak } from '@/lib/voice/voicePlaybackStore'
import type { NarrationSpeakerView } from '@/hooks/useMultiVoiceNarration'

const VOICE_OPTIONS: RichOptionGroup[] = [{
  label: undefined,
  options: KOKORO_VOICE_IDS.map((id) => {
    const meta = voiceMeta(id)!
    return { value: `kokoro:${id}`, label: `${meta.flag} ${meta.name}`, description: meta.description }
  }),
}]

export function SpeakerAssignmentPanel({
  speakers,
  onVoiceChange,
}: {
  speakers: NarrationSpeakerView[]
  onVoiceChange: (speakerId: string, voiceId: string) => void
}) {
  if (!speakers.length) return null

  return (
    <div className="space-y-2 rounded-card border border-border bg-background/50 p-3">
      <p className="text-[11px] text-muted-foreground">
        {speakers.filter((s) => !s.isNarrator).length > 0
          ? 'Detected speakers: each gets its own voice.'
          : 'No dialogue detected, read in a single voice.'}
      </p>
      <div className="space-y-1.5">
        {speakers.map((s) => {
          const meta = voiceMeta(s.voiceId)
          return (
            <div key={s.id} className="flex items-center gap-2">
              <span className="w-24 shrink-0 truncate text-[11px] font-medium">
                {s.label}
                {s.isNarrator && <span className="ml-1 text-muted-foreground">(narrator)</span>}
              </span>
              <div className="min-w-0 flex-1">
                <RichOptionSelect
                  groups={VOICE_OPTIONS}
                  value={s.voiceId}
                  onChange={(v) => onVoiceChange(s.id, v)}
                  placeholder="Choose a voice"
                />
              </div>
              <button
                type="button"
                onClick={() => void speak({ text: `Hi, I'm ${s.label}.`, ttsVoice: s.voiceId })}
                title="Preview voice"
                className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border hover:bg-foreground/5"
              >
                <Play className="size-3.5" />
              </button>
              {meta && <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">{meta.description}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
