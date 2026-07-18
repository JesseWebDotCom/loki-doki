// Recent resource-management actions (evictions, re-warms, spill remediations), kept
// in a small ring so the admin Resource health card can show "is it working?" at a
// glance instead of asking the operator to read `[resource]` log lines. Paired with
// the logger calls at each site, not a replacement for them.

export type ResourceEventKind = 'evict' | 'rewarm' | 'remediate'

export interface ResourceEvent {
  kind: ResourceEventKind
  message: string
  at: number
}

const CAP = 30
const ring: ResourceEvent[] = []

export function recordResourceEvent(kind: ResourceEventKind, message: string): void {
  ring.push({ kind, message, at: Date.now() })
  if (ring.length > CAP) ring.shift()
}

/** Most recent first. */
export function recentResourceEvents(limit = 12): ResourceEvent[] {
  return ring.slice(-limit).reverse()
}
