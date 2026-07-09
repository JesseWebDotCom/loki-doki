// Music content-protection policy for the signed-in user. Enforcement (queue filtering,
// lyrics gating) is server-side; the frontend uses this for presentation: masking titles
// in player surfaces and knowing when to show a "lyrics hidden" state.

import { useQuery } from '@tanstack/react-query'

export interface MusicPolicy {
  explicit: 'block' | 'allow'
  unknown: 'block' | 'allow'
  lyrics: 'hide-explicit' | 'show'
  maskTitles: boolean
}

const OPEN: MusicPolicy = { explicit: 'allow', unknown: 'allow', lyrics: 'show', maskTitles: false }

export function useMusicPolicy(): MusicPolicy {
  const { data } = useQuery({
    queryKey: ['music-policy'],
    queryFn: async (): Promise<MusicPolicy> => {
      const res = await fetch('/api/music/info/policy', { credentials: 'include' })
      if (!res.ok) return OPEN
      return await res.json() as MusicPolicy
    },
    staleTime: 5 * 60 * 1000,
  })
  return data ?? OPEN
}

// A modest profanity list for TITLE masking only (song titles, not lyrics - lyrics are
// gated server-side). Inner letters become bullets: "F**k" style, first+last kept so
// the household still recognizes the song.
const MASK_WORDS = /\b(fuck\w*|shit\w*|bitch\w*|asshole|bastard|cunt|dick\w*|pussy|nigga\w*|whore|slut\w*|cock\w*|motherfuck\w*|goddamn)\b/gi

export function maskTitle(title: string): string {
  return title.replace(MASK_WORDS, (w) =>
    w.length <= 2 ? w : `${w[0]}${'•'.repeat(w.length - 2)}${w[w.length - 1]}`)
}

/** Hook form: returns a title transformer honoring the user's profile. */
export function useTitleMask(): (title: string) => string {
  const policy = useMusicPolicy()
  return policy.maskTitles ? maskTitle : (t: string) => t
}
