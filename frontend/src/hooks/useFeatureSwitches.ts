import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/lib/toast'

export type FeaturePartState =
  | 'installed' | 'missing' | 'installing' | 'failed' | 'unsupported' | 'needs-approval' | 'needs-pkg-manager'

export interface FeaturePart {
  id: string
  label: string
  kind: 'component' | 'model'
  state: FeaturePartState
  approxBytes: number
  optional: boolean
  error?: string
}

export interface FeatureSwitch {
  id: string
  label: string
  description: string
  state: 'off' | 'installing' | 'on' | 'error'
  enabled: boolean
  degraded: boolean
  bytesRequired: number
  parts: FeaturePart[]
  progress?: { completed: number; total: number; label: string }
  contentNote?: string
}

interface FeaturesResponse {
  features: FeatureSwitch[]
  disk: { freeBytes: number; totalBytes: number }
}

/** The one-switch Features hub state: polls while an install is running, and exposes
 *  enable/disable/repair mutations against the orchestrator. Admin-only endpoints. */
export function useFeatureSwitches() {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['features'],
    queryFn: async () => {
      const r = await fetch('/api/features', { credentials: 'include' })
      if (!r.ok) throw new Error('features failed')
      return (await r.json()) as FeaturesResponse
    },
    refetchInterval: (q) => (q.state.data?.features.some((f) => f.state === 'installing') ? 2000 : false),
    staleTime: 5 * 1000,
  })

  const act = (verb: 'enable' | 'disable' | 'repair') =>
    useMutation({
      mutationFn: async (id: string) => {
        const r = await fetch(`/api/features/${id}/${verb}`, { method: 'POST', credentials: 'include' })
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? `Could not ${verb} the feature`)
        }
        return (await r.json()) as FeatureSwitch
      },
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ['features'] })
        void qc.invalidateQueries({ queryKey: ['tools'] })
        void qc.invalidateQueries({ queryKey: ['app-features'] })
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Something went wrong'),
    })

  /* eslint-disable react-hooks/rules-of-hooks -- fixed call order: the three
     useMutation calls below run unconditionally on every render */
  const enable = act('enable')
  const disable = act('disable')
  const repair = act('repair')
  /* eslint-enable react-hooks/rules-of-hooks */

  return { ...query, enable, disable, repair }
}
