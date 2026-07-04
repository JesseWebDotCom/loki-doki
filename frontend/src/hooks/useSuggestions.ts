import { useEffect, useRef, useState } from 'react'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import type { Suggestion, SuggestSource } from '@/lib/smartSearch/types'

export interface UseSuggestionsOptions {
  minLength?: number
  debounceMs?: number
}

/** Debounced, abort-safe query-suggestion fetching — generalizes the pattern
 *  SpotlightSearch.tsx uses for its own (hardcoded) result fetching. */
export function useSuggestions(query: string, suggest: SuggestSource, opts: UseSuggestionsOptions = {}) {
  const { minLength = 2, debounceMs = 180 } = opts
  const debounced = useDebouncedValue(query, debounceMs)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    abortRef.current?.abort()
    if (debounced.trim().length < minLength) { setSuggestions([]); setLoading(false); return }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    suggest(debounced, ctrl.signal)
      .then(results => { if (!ctrl.signal.aborted) setSuggestions(results) })
      .catch(() => { if (!ctrl.signal.aborted) setSuggestions([]) })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  }, [debounced, minLength, suggest])

  return { suggestions, loading }
}
