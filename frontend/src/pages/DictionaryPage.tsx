import { useCallback, useState } from 'react'
import { BookOpen, Volume2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { PageShell } from '@/components/shared/PageShell'
import { PageContainer } from '@/components/shared/PageContainer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'

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
    <div className="space-y-5 pt-2">
      <div className="space-y-2">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-5 w-32" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-5 w-20 rounded-full" />
          <div className="space-y-2 pl-4">
            <Skeleton className="h-4 w-full max-w-lg" />
            <Skeleton className="h-4 w-4/5 max-w-md" />
            <Skeleton className="h-4 w-3/5 max-w-sm" />
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

  useAppHeader({
    query: inputValue,
    setQuery: setInputValue,
    onSubmit: handleSubmit,
    placeholder: 'Enter a word...',
    loading: !!isFetching,
    externalHref: 'https://en.wiktionary.org',
  })

  function playAudio(url: string) {
    new Audio(url).play().catch(() => {})
  }

  const showEmpty = !submittedWord
  const showLoading = isFetching && submittedWord
  const showNotFound = !isFetching && data?.error === 'not_found'
  const showResult = !isFetching && data && !data.error

  return (
    <PageShell>
      <PageContainer width="narrow" className="flex flex-col gap-5 pt-6 pb-10">

        {/* Empty state */}
        {showEmpty && (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <div className="flex size-14 items-center justify-center rounded-card bg-brand/15">
              <BookOpen className="size-7 text-brand" />
            </div>
            <p className="text-base font-semibold">Dictionary</p>
            <p className="max-w-xs text-sm text-muted-foreground">Search any word for definitions, phonetics, usage examples, and audio pronunciation.</p>
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
                <h2 className="text-display text-foreground">{data.word}</h2>
                {data.audio && (
                  <Button
                    variant="tinted"
                    size="icon"
                    className="size-8"
                    onClick={() => playAudio(data.audio!)}
                    aria-label="Play pronunciation"
                  >
                    <Volume2 className="size-4" />
                  </Button>
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
      </PageContainer>
    </PageShell>
  )
}
