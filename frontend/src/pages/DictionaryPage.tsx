import { useCallback, useState } from 'react'
import { BookOpen, Volume2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { PageShell } from '@/components/shared/PageShell'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { useBreadcrumbSearch } from '@/context/BreadcrumbSearchContext'

interface Definition { definition: string; example?: string }
interface Meaning { partOfSpeech: string; definitions: Definition[] }
interface DictionaryResult {
  word: string
  phonetic?: string
  audio: string | null
  meanings: Meaning[]
  error?: string
}

async function fetchDefinition(word: string): Promise<DictionaryResult> {
  const r = await fetch(`/api/dictionary?q=${encodeURIComponent(word)}`, { credentials: 'include' })
  if (!r.ok) throw new Error('Request failed')
  return r.json() as Promise<DictionaryResult>
}

function SkeletonLines() {
  return (
    <div className="space-y-5 animate-pulse pt-2">
      <div className="space-y-2">
        <div className="h-9 w-48 rounded-lg bg-foreground/10" />
        <div className="h-5 w-32 rounded-lg bg-foreground/8" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3">
          <div className="h-5 w-20 rounded-full bg-foreground/10" />
          <div className="space-y-2 pl-4">
            <div className="h-4 w-full max-w-lg rounded bg-foreground/8" />
            <div className="h-4 w-4/5 max-w-md rounded bg-foreground/8" />
            <div className="h-4 w-3/5 max-w-sm rounded bg-foreground/8" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function DictionaryPage() {
  const [inputValue, setInputValue] = useState('')
  const [submittedWord, setSubmittedWord] = useState('')

  const { data, isFetching } = useQuery<DictionaryResult>({
    queryKey: ['dictionary', submittedWord],
    queryFn: () => fetchDefinition(submittedWord),
    enabled: submittedWord.length > 0,
    staleTime: 60 * 60 * 1000,
  })

  const handleSubmit = useCallback(() => {
    const word = inputValue.trim()
    if (word) setSubmittedWord(word)
  }, [inputValue])

  useBreadcrumbSearch({
    query: inputValue,
    setQuery: setInputValue,
    onSubmit: handleSubmit,
    placeholder: 'Enter a word...',
    loading: !!isFetching,
    externalHref: 'https://en.wiktionary.org',
    settingsHref: '/admin/features?tool=dictionary',
  })

  function playAudio(url: string) {
    new Audio(url).play().catch(() => {})
  }

  const showEmpty = !submittedWord
  const showLoading = isFetching && submittedWord
  const showNotFound = !isFetching && data?.error === 'not_found'
  const showResult = !isFetching && data && !data.error

  return (
    <PageShell gradient="linear-gradient(135deg,#1e3a5f,#1d4ed8)" GhostIcon={BookOpen}>
      <div className="flex flex-col gap-5 px-5 pt-6 pb-10">

        {/* Empty state */}
        {showEmpty && (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <BookOpen className="size-12 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">Look up a word</p>
          </div>
        )}

        {/* Loading skeleton */}
        {showLoading && <SkeletonLines />}

        {/* Not found */}
        {showNotFound && (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <BookOpen className="size-12 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              No definition found for{' '}
              <span className="font-semibold text-foreground">{data?.word ?? submittedWord}</span>
            </p>
          </div>
        )}

        {/* Result */}
        {showResult && data && (
          <div className="space-y-6">
            {/* Word + phonetic + audio */}
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-4xl font-black tracking-tight">{data.word}</h1>
                {data.audio && (
                  <button
                    onClick={() => playAudio(data.audio!)}
                    aria-label="Play pronunciation"
                    className={cn(
                      'flex size-8 items-center justify-center rounded-full',
                      'bg-foreground/8 text-muted-foreground transition-colors hover:bg-brand/15 hover:text-brand',
                    )}
                  >
                    <Volume2 className="size-4" />
                  </button>
                )}
              </div>
              {data.phonetic && (
                <p className="mt-1 text-lg text-muted-foreground">{data.phonetic}</p>
              )}
            </div>

            {/* Meanings */}
            <div className="space-y-6">
              {data.meanings.map((meaning, mi) => (
                <div key={mi} className="space-y-3">
                  <Badge className="bg-brand/15 text-brand border-brand/25">
                    {meaning.partOfSpeech}
                  </Badge>
                  <ol className="space-y-3 pl-1">
                    {meaning.definitions.map((def, di) => (
                      <li key={di} className="flex gap-3 text-sm">
                        <span className="mt-0.5 shrink-0 font-semibold tabular-nums text-muted-foreground/60">
                          {di + 1}.
                        </span>
                        <div className="space-y-1">
                          <p className="leading-relaxed">{def.definition}</p>
                          {def.example && (
                            <p className="italic text-muted-foreground">{def.example}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </PageShell>
  )
}
