// Shared "Not interested" behavior for suggestion rails: optimistic local hide, a toast
// with Undo, and the server dismiss/undismiss round trip. Pages filter their rail items
// against `hidden` so the card vanishes immediately; the server keeps it excluded on the
// next fetch.

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { dismissSuggestion, undismissSuggestion, type DismissMeta, type InterestDomain } from '@/lib/interestsApi'

export interface DismissTarget extends DismissMeta {
  ref: string
}

export function useSuggestionDismiss(domain: InterestDomain) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>())

  const dismiss = useCallback((target: DismissTarget) => {
    setHidden((prev) => new Set(prev).add(target.ref))
    void dismissSuggestion(domain, target.ref, target)
    toast('Got it, showing fewer like this', {
      action: {
        label: 'Undo',
        onClick: () => {
          setHidden((prev) => {
            const next = new Set(prev)
            next.delete(target.ref)
            return next
          })
          void undismissSuggestion(domain, target.ref)
        },
      },
    })
  }, [domain])

  return { hidden, dismiss }
}
