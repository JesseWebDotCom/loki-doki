// Hover/focus intent prefetch: warm an app's data the instant the pointer enters (or the
// keyboard focuses) its nav link — the strongest "I'm about to click this" signal. Cheap to
// fire repeatedly: prefetchQuery respects staleTime + dedupes, image preloads dedupe by URL.

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getAppByPath } from '@/lib/appCategories'
import { APP_PREFETCHERS } from './registry'
import { useWarmCtx } from './useWarmContext'

/** Returns `prefetch(href)` — resolves the href to an app id and runs its prefetcher. */
export function useIntentPrefetch(): (href: string) => void {
  const qc = useQueryClient()
  const { online, location } = useWarmCtx()
  return useCallback(
    (href: string) => {
      const app = getAppByPath(href)
      if (!app) return
      const fn = APP_PREFETCHERS[app.id]
      if (fn) void fn(qc, { online, location })
    },
    [qc, online, location],
  )
}
