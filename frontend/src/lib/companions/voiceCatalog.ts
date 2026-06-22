// Friendly metadata for the Kokoro voices our companions use. Kokoro voice ids
// encode region + gender in the first two letters (a=American, b=British; f=female,
// m=male), e.g. `bf_emma` = British female "Emma". We derive flag/gender from that
// and layer a curated one-line description on top.

export interface VoiceMeta {
  id: string            // bare voice id, e.g. 'bf_emma'
  name: string          // 'Emma'
  gender: 'Male' | 'Female' | 'Neutral'
  country: string       // 'British' | 'American'
  flag: string          // 🇺🇸 / 🇬🇧
  description: string    // short blurb
}

const REGION: Record<string, { country: string; flag: string }> = {
  a: { country: 'American', flag: '🇺🇸' },
  b: { country: 'British', flag: '🇬🇧' },
}

const GENDER: Record<string, VoiceMeta['gender']> = { f: 'Female', m: 'Male' }

// Curated descriptions for the voices in our default roster.
const DESCRIPTIONS: Record<string, string> = {
  am_michael: 'Warm, easy-going everyday voice',
  bm_george: 'Refined, measured, with gravitas',
  am_puck: 'Playful and upbeat',
  bf_emma: 'Polished and professional',
  af_heart: 'Warm and gentle — great for kids',
  af_bella: 'Bright and high-energy',
  af_sarah: 'Soft and soothing',
  am_echo: 'Bright and expressive',
  bm_lewis: 'Dry, deadpan delivery',
  af_nicole: 'Soft and intimate',
  af_sky: 'Smooth and sultry',
  am_onyx: 'Deep and gravelly',
}

function bareId(ttsVoice: string): string {
  return ttsVoice.includes(':') ? ttsVoice.split(':').pop()! : ttsVoice
}

/** Resolve friendly voice metadata from a qualified/bare voice id. null = app default. */
export function voiceMeta(ttsVoice: string | null | undefined): VoiceMeta | null {
  if (!ttsVoice) return null
  const id = bareId(ttsVoice)
  const region = REGION[id[0]?.toLowerCase() ?? '']
  const gender = GENDER[id[1]?.toLowerCase() ?? ''] ?? 'Neutral'
  const rawName = id.replace(/^[a-z]{2}_/i, '').replace(/_/g, ' ')
  const name = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : id
  return {
    id,
    name,
    gender,
    country: region?.country ?? '',
    flag: region?.flag ?? '🔊',
    description: DESCRIPTIONS[id] ?? `${region?.country ?? ''} ${gender.toLowerCase()} voice`.trim(),
  }
}
