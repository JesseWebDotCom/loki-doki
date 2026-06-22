// Per-character voice resolution. Ported from v2 `voice_resolver.py`.
//
// Order: character → user → app catalog default. Empty strings are treated as
// unset. This is the fallback chain the product requires: a character with no
// voice falls back to the user default, then the app-wide default voice.

export function resolveVoice(opts: {
  characterVoice: string | null | undefined
  userVoice: string | null | undefined
  catalogDefault: string
}): string {
  if (opts.characterVoice) return opts.characterVoice
  if (opts.userVoice) return opts.userVoice
  return opts.catalogDefault
}
