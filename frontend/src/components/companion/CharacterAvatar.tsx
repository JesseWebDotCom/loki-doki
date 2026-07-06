import RiggedDicebearAvatar from './RiggedDicebearAvatar'
import RoboEyesAvatar from './RoboEyesAvatar'
import { coerceStyle, ROBO_EYES_STYLE } from './styles'
import type { HeadTiltState } from './useHeadTilt'
import { useAmbientTilt } from './useAmbientTilt'
import { useCharacterViseme } from '@/lib/voice/voicePlaybackStore'
import type { Mood } from './moods'

export interface CharacterLike {
  renderer?: string | null
  style?: string | null
  seed?: string | null
  avatarConfig?: Record<string, unknown> | null
  name?: string
}

interface Props {
  character: CharacterLike | null
  /** Tokens streaming → talking (head sway + mouth flap). */
  streaming?: boolean
  /** Turn started, no tokens yet → thinking pose. */
  thinking?: boolean
  sleeping?: boolean
  /** Hands-free mic is actively capturing speech → listening pose. */
  listening?: boolean
  /** Explicit tilt-state override (studio brain buttons). */
  tiltState?: HeadTiltState
  manualTiltDeg?: number | null
  size?: number
  /** Kept for call-site compatibility — RiggedDicebearAvatar is already head-framed. */
  viewPreset?: 'full' | 'head'
  className?: string
  pokeable?: boolean
  /** Drive the mouth from live TTS audio (companion/chat) instead of the text-cadence flap. */
  audioLipSync?: boolean
  /** Emote overlay (eyes/eyebrows) driven by parsed *…* emotes. */
  mood?: Mood
  /** Skip overlay animations so caller can render them outside an overflow-hidden container. */
  suppressOverlays?: boolean
  /** Static-preview mode (store grid): seed-assigned resting pose + occasional brief emote. */
  ambient?: boolean
}

// Moods that have a matching HeadTiltState — elevates the emote from face-only to full-body.
const MOOD_TILT: Partial<Record<Mood, HeadTiltState>> = {
  angry: 'angry',
  sad: 'sad',
  surprised: 'shocked',
  sick: 'sick',
}

function deriveTilt(streaming: boolean, thinking: boolean, sleeping: boolean, listening: boolean, mood: Mood): HeadTiltState {
  if (sleeping) return 'sleeping'
  if (thinking) return 'thinking'
  if (listening) return 'listening'
  const moodTilt = MOOD_TILT[mood]
  if (moodTilt) return moodTilt
  if (streaming) return 'speaking'
  return 'dozing'
}

/**
 * The reusable animated buddy. Wraps the verbatim-ported v2 RiggedDicebearAvatar
 * (pivot-based head tilt) and maps high-level chat signals to a HeadTiltState.
 */
export function CharacterAvatar({ character, streaming = false, thinking = false, sleeping = false, listening = false, tiltState, manualTiltDeg, size, className, audioLipSync = false, mood = 'neutral', suppressOverlays = false, ambient = false }: Props) {
  // Subscribe to the audio bridge unconditionally (hooks must be called in a
  // stable order) but only let it drive the mouth when audioLipSync is on.
  const audioViseme = useCharacterViseme(audioLipSync)
  // Ambient resting/emote state for static previews — keyed to the same seed the
  // avatar renders with so the phase desync and ambient cycle stay consistent.
  const ambientTilt = useAmbientTilt(character?.seed ?? character?.name ?? 'companion', ambient)
  if (!character) return null
  const liveTilt = deriveTilt(streaming, thinking, sleeping, listening, mood)
  // Live signals always win; ambient only fills in the otherwise-idle resting pose.
  const tilt = tiltState ?? (ambient && liveTilt === 'dozing' ? ambientTilt : liveTilt)
  // Procedural non-DiceBear renderer: branch before coerceStyle so the DiceBear
  // machinery never sees the 'robo-eyes' style id.
  if (character.style === ROBO_EYES_STYLE) {
    return (
      <RoboEyesAvatar
        seed={character.seed ?? character.name ?? 'companion'}
        config={character.avatarConfig ?? {}}
        size={size}
        className={className}
        tiltState={tilt}
        manualTiltDeg={manualTiltDeg ?? null}
        speaking={streaming}
        audioViseme={audioLipSync ? audioViseme : undefined}
        mood={mood}
        suppressOverlays={suppressOverlays}
      />
    )
  }
  return (
    <RiggedDicebearAvatar
      style={coerceStyle(character.style)}
      seed={character.seed ?? character.name ?? 'companion'}
      baseOptions={character.avatarConfig ?? {}}
      size={size}
      className={className}
      tiltState={tilt}
      manualTiltDeg={manualTiltDeg ?? null}
      speaking={streaming}
      audioViseme={audioLipSync ? audioViseme : undefined}
      mood={mood}
      suppressOverlays={suppressOverlays}
    />
  )
}
