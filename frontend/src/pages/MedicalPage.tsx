import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HeartPulse, Loader2, TriangleAlert, ExternalLink, WifiOff } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'

interface MedicalResult {
  gist: string | null
  highlights: string[]
  sources: string[]
  depth_available: boolean
  offline: boolean
  error?: string
}

async function fetchMedical(q: string): Promise<MedicalResult> {
  const r = await fetch(`/api/medical?q=${encodeURIComponent(q)}`, { credentials: 'include' })
  return r.json() as Promise<MedicalResult>
}

export function MedicalPage() {
  const [input, setInput] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')

  usePublishUIContext({
    label: 'Medical Reference',
    description: submittedQuery
      ? `User looked up: ${submittedQuery}`
      : 'User is on the Medical Reference page.',
  })

  const { data, isFetching, isError } = useQuery<MedicalResult>({
    queryKey: ['medical', submittedQuery],
    queryFn: () => fetchMedical(submittedQuery),
    enabled: !!submittedQuery,
    staleTime: 10 * 60 * 1000,
  })

  const handleSubmit = useCallback(() => {
    const q = input.trim()
    if (q) setSubmittedQuery(q)
  }, [input])

  useAppHeader({
    query: input,
    setQuery: setInput,
    onSubmit: handleSubmit,
    placeholder: 'Search conditions, medications...',
    loading: isFetching,
    externalHref: 'https://medlineplus.gov',
    settingsHref: '/admin/features?tool=medical',
  })

  const hasError = isError || (data && (data.error || data.gist === null))
  const showResults = !isFetching && data && !hasError && data.gist

  return (
    <PageShell gradient="linear-gradient(135deg,#164e63,#0891b2)" GhostIcon={HeartPulse}>
      <PageHeader
        variant="compact"
        title="Medical Reference"
        subtitle="Look up symptoms, conditions, medications, and health information."
        gradient="linear-gradient(135deg,#164e63,#0891b2)"
        icon={<HeartPulse className="size-7 text-white" />}
      />

      <div className="flex flex-col gap-4 px-5 pb-10">
        {/* Disclaimer banner */}
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/40">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-amber-800 dark:text-amber-200">
            For informational purposes only. Always consult a qualified healthcare provider for
            medical advice, diagnosis, or treatment.
          </p>
        </div>

        {/* Loading state */}
        {isFetching && (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        )}

        {/* Error state */}
        {!isFetching && (isError || (data && (data.error || data.gist === null))) && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <WifiOff className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              Could not retrieve information. Check your connection and try again.
            </p>
          </div>
        )}

        {/* Results */}
        {showResults && (
          <div className="space-y-4">
            {/* Offline badge */}
            {data.offline && (
              <div className="inline-flex items-center gap-1.5 rounded-full border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                <WifiOff className="size-3" />
                Offline (WikiMed)
              </div>
            )}

            {/* Gist */}
            <p className={cn('text-base font-medium leading-relaxed')}>{data.gist}</p>

            {/* Highlights */}
            {data.highlights.length > 0 && (
              <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                {data.highlights.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            )}

            {/* Sources */}
            {data.sources.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {data.sources.map((src, i) => (
                  <a
                    key={i}
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-brand/40 hover:text-foreground"
                  >
                    {(() => {
                      try {
                        return new URL(src).hostname.replace(/^www\./, '')
                      } catch {
                        return src
                      }
                    })()}
                    <ExternalLink className="size-3" />
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Default / empty state */}
        {!submittedQuery && !isFetching && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <HeartPulse className="size-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              Look up a medical condition or medication
            </p>
          </div>
        )}
      </div>
    </PageShell>
  )
}
