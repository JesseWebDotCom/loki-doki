// Registry of live Pod connections, so server-side producers (the scheduler,
// notifications, ambient triggers) can push events to a user's connected Pods
// over their persistent Wyoming socket — the push channel the architecture relies
// on instead of device polling.

export interface PodFireEvent {
  kind: 'alarm' | 'timer'
  label: string
  tone?: string | null
  announce?: boolean
}

/** Anything that can receive a pushed event for a bound user (a SatelliteSession). */
export interface PodFireTarget {
  /** The user this connection is bound to (null until authenticated/resolved). */
  readonly boundUserId: string | null
  /** The paired device id this connection authenticated as (null until auth). */
  readonly deviceId: string | null
  /** Current conversation state for the admin live badge (idle|listening|thinking|talking). */
  readonly activity: string
  fire(event: PodFireEvent): void
}

const live = new Set<PodFireTarget>()

export function registerPod(target: PodFireTarget): void {
  live.add(target)
}

export function unregisterPod(target: PodFireTarget): void {
  live.delete(target)
}

/** Live Pods bound to a given user. */
export function podsForUser(userId: string): PodFireTarget[] {
  const out: PodFireTarget[] = []
  for (const t of live) if (t.boundUserId === userId) out.push(t)
  return out
}

/** Are any Pods connected at all? Lets producers skip work when nothing's listening. */
export function anyPodsConnected(): boolean {
  return live.size > 0
}

/** Device ids with a live gateway socket right now — the source of truth for the
 *  admin panel's online/offline dot (a paired device is "online" only while its
 *  Wyoming socket is open, distinct from the `lastSeenAt` timestamp). */
export function connectedDeviceIds(): Set<string> {
  const out = new Set<string>()
  for (const t of live) if (t.deviceId) out.add(t.deviceId)
  return out
}

/** deviceId → current conversation state, for the admin live-activity badge. */
export function connectedActivity(): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of live) if (t.deviceId) out.set(t.deviceId, t.activity)
  return out
}
