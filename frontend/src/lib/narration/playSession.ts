// Fire-and-forget multi-voice playback for a companion-triggered narration
// directive: no page-scoped resume position or progress UI, just "start reading
// this now with these voices," the same streaming pipeline useMultiVoiceNarration
// drives, minus the React state.

import { enqueueSpeech } from '@/lib/voice/voicePlaybackStore'

export interface NarrationPlayTurn {
  voiceId: string | null
  text: string
}

/** Batch consecutive same-voice turns into one TTS request. */
function packBatches(turns: NarrationPlayTurn[]): NarrationPlayTurn[] {
  const out: NarrationPlayTurn[] = []
  for (const t of turns) {
    const last = out[out.length - 1]
    if (last && last.voiceId === t.voiceId) {
      last.text += '\n\n' + t.text
    } else {
      out.push({ ...t })
    }
  }
  return out
}

export async function playNarrationTurns(turns: NarrationPlayTurn[]): Promise<void> {
  for (const batch of packBatches(turns)) {
    await enqueueSpeech({ text: batch.text, ttsVoice: batch.voiceId })
  }
}
