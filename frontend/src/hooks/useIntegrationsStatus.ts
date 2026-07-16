import { useQuery } from '@tanstack/react-query'

export type IntegrationState = 'connected' | 'configured' | 'not_configured' | 'error'

export interface IntegrationStatusRow {
  id: string
  state: IntegrationState
  url: string | null
  detail: string | null
  error: string | null
}

/** Admin-only aggregate status for every integration. `probe: false` is instant
 *  (DB-only configured state); `probe: true` adds live reachability, cached 60s
 *  server-side. Render the cheap rows first and let the probed rows upgrade them. */
export function useIntegrationsStatus(probe: boolean) {
  return useQuery({
    queryKey: ['integrations-status', probe],
    queryFn: async () => {
      const r = await fetch(`/api/integrations/status${probe ? '?probe=1' : ''}`, { credentials: 'include' })
      if (!r.ok) throw new Error('status failed')
      return (await r.json()) as { rows: IntegrationStatusRow[]; probed: boolean }
    },
    staleTime: 60 * 1000,
  })
}
