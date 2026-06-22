// Voice subsystem barrel + engine dispatch.

import type { EngineId } from '@/lib/voice/engineRegistry'
import type { TtsEngine } from '@/lib/voice/types'
import { kokoroEngine } from '@/lib/voice/engines/kokoroEngine'

const ENGINES: Record<EngineId, TtsEngine> = {
  kokoro: kokoroEngine,
}

export function getTtsEngine(engine: EngineId): TtsEngine {
  return ENGINES[engine]
}

export * from '@/lib/voice/engineRegistry'
export * from '@/lib/voice/voiceResolver'
export * from '@/lib/voice/sentenceSegmenter'
export * from '@/lib/voice/types'
export * as voiceConfig from '@/lib/voice/config'
