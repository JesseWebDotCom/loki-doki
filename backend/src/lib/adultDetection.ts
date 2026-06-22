import { getAppSetting } from '@/lib/settings'

export const DEFAULT_ADULT_KEYWORDS: string[] = [
  'nsfw', 'nude', 'naked', 'explicit', 'adult', 'porn', 'xxx',
  'hentai', 'erotic', 'sexual', 'uncensored', 'lingerie', 'fetish',
  'bdsm', 'nipple', 'breast', 'genitals', 'vagina', 'penis', 'sex',
  'lewd', 'ecchi', 'ahegao', 'tentacle', 'futa', 'futanari',
  'exhibitionism', 'voyeur', 'bondage', 'r18', 'r-18', '18+',
  'x-rated', 'bodily fluid', 'suggestive', 'mature content',
  'sexually explicit', 'undress', 'topless', 'bottomless',
]

export async function getAdultKeywords(): Promise<string[]> {
  try {
    const custom = await getAppSetting('privacy.adult_keywords') as string[] | null
    if (Array.isArray(custom) && custom.length > 0) return custom
  } catch { /* ignore */ }
  return DEFAULT_ADULT_KEYWORDS
}

export function detectIsAdult(
  name: string,
  description: string,
  civitaiNsfw?: boolean,
  keywords?: string[],
): boolean {
  if (civitaiNsfw === true) return true

  const kws = keywords ?? DEFAULT_ADULT_KEYWORDS
  const haystack = `${name} ${description}`.toLowerCase()

  for (const kw of kws) {
    const needle = kw.toLowerCase().trim()
    if (needle && haystack.includes(needle)) return true
  }
  return false
}
