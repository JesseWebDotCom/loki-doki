import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Languages, Check } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { translateLyrics, type TranslatedLyricLine, type LyricLine } from '@/lib/music/catalogApi'
import { usePreferenceValue } from '@/hooks/usePreferenceValue'
import { Spinner } from '@/components/ui/spinner'

// Shared language menu + translation query for every synced-lyrics surface (Karaoke,
// the Now Playing lyrics panel). The chosen language and the pronunciation toggle are
// per-user preferences; the translations themselves are generated once per (track,
// language) server-side and cached.

export const LYRIC_LANG_OPTIONS: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ar', label: 'Arabic' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'tl', label: 'Tagalog' },
]

const LANG_PREF = 'music.lyricsTranslateLang'   // '' = off
const ROMAN_PREF = 'music.lyricsShowRoman'

// Mirrors the backend detection: a line in a non-Latin script gets a pronunciation guide.
const NON_LATIN_RE = /[Ͱ-ϿЀ-ӿ԰-֏֐-׿؀-ۿऀ-෿฀-๿ᄀ-ᇿ぀-ヿ㄰-㆏一-鿿가-힯]/

// Tiny stable fingerprint for the query key (the server re-verifies with a real hash).
function fingerprint(lines: string[]): string {
  let h = 5381
  const s = lines.join('\n')
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h)
}

export interface LyricsTranslationState {
  lang: string
  setLang: (code: string) => void
  showRoman: boolean
  setShowRoman: (v: boolean) => void
  /** One entry per source line (same order), or null while off / unavailable. */
  secondary: TranslatedLyricLine[] | null
  loading: boolean
  hasNonLatin: boolean
}

export function useLyricsTranslation(artist: string, title: string, lines: LyricLine[] | null): LyricsTranslationState {
  const [lang, setLang] = usePreferenceValue<string>(LANG_PREF, '')
  const [showRoman, setShowRoman] = usePreferenceValue<boolean>(ROMAN_PREF, true)

  const texts = useMemo(() => (lines?.length ? lines.map((l) => l.text) : null), [lines])
  const hasNonLatin = useMemo(() => !!texts?.some((t) => NON_LATIN_RE.test(t)), [texts])
  const fp = useMemo(() => (texts ? fingerprint(texts) : ''), [texts])

  const query = useQuery({
    queryKey: ['lyrics-translate', artist, title, lang, fp],
    queryFn: () => translateLyrics(artist, title, lang, texts!),
    enabled: !!lang && !!texts?.length,
    staleTime: Infinity,
    retry: 1,
  })

  // Graceful failure: a quiet toast, normal lyrics keep rendering untranslated.
  useEffect(() => {
    if (query.isError) toast.error('Could not translate the lyrics right now')
  }, [query.isError])

  return {
    lang, setLang, showRoman, setShowRoman,
    secondary: lang ? (query.data?.lines ?? null) : null,
    loading: !!lang && query.isFetching,
    hasNonLatin,
  }
}

// The language menu button. `tone="stage"` matches the karaoke stage chrome (white on
// dark); the default tone follows the themed surface it sits on.
export function LyricsLanguageMenu({ state, tone = 'default', className }: {
  state: LyricsTranslationState
  tone?: 'default' | 'stage'
  className?: string
}) {
  const { lang, setLang, showRoman, setShowRoman, loading, hasNonLatin } = state
  const activeLabel = LYRIC_LANG_OPTIONS.find((o) => o.code === lang)?.label

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={activeLabel ? `Lyrics translated to ${activeLabel}` : 'Translate lyrics'}
          className={cn(
            'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition',
            // design-ok(glass-on-plain-bg): the stage tone renders only on the karaoke
            // dark stage (itself an allowlisted glass surface), matching its chrome.
            tone === 'stage'
              ? (lang ? 'bg-white text-black' : 'bg-white/10 text-white/70 hover:bg-white/20 hover:text-white')
              : (lang ? 'bg-brand text-brand-foreground' : 'bg-foreground/8 text-muted-foreground hover:text-foreground'),
            className,
          )}>
          {loading ? <Spinner className="size-3.5" /> : <Languages className="size-3.5" />}
          {activeLabel ?? 'Translate'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-52 overflow-y-auto">
        <DropdownMenuLabel>Translate lyrics</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => setLang('')}>
          {!lang && <Check className="size-4" />}
          <span className={cn(lang && 'pl-6')}>Off</span>
        </DropdownMenuItem>
        {LYRIC_LANG_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.code} onClick={() => setLang(o.code)}>
            {lang === o.code && <Check className="size-4" />}
            <span className={cn(lang !== o.code && 'pl-6')}>{o.label}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={showRoman}
          onCheckedChange={(v) => setShowRoman(!!v)}
          disabled={!hasNonLatin}>
          Pronunciation guide
        </DropdownMenuCheckboxItem>
        {!hasNonLatin && (
          <p className="px-2 pb-1.5 pt-0.5 text-[11px] leading-snug text-muted-foreground">
            Shown for songs written in a non-Latin script.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
