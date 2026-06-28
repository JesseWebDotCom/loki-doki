// Frigate integration API client. Browser-facing announce polling + admin config.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export interface FrigateAnnouncement {
  id: string
  title: string | null
  camera: string | null
  kind: 'object' | 'plate' | 'review' | 'description'
  snapshotUrl: string | null
}

export interface FrigateEvent extends FrigateAnnouncement {
  source: 'genai' | 'mqtt'
  label: string | null
  subLabel: string | null
  plate: string | null
  plateName: string | null
  severity: string | null
  description: string | null
  createdAt: number
}

export interface FrigateConfig {
  enabled: boolean
  baseUrl: string
  mqttHost: string
  mqttPort: number
  mqttUsername: string
  announce: string[]
  knownPlates: Record<string, string>
  shimTokenSet: boolean
  mqttPasswordSet: boolean
  allAnnounceTypes: string[]
  /** Full base_url Frigate should use to reach this app's shim (LAN IP + backend port). */
  shimBaseUrl: string
}

export interface FrigateTestResult {
  frigate: { configured: boolean; ok: boolean; version?: string; error?: string }
  mqtt: { configured: boolean; connected: boolean }
}

// ── Announce polling (any authenticated client) ───────────────────────────────

// Lightweight gate: is Frigate actually set up? Clients use this to avoid polling for
// announcements every few seconds when Frigate is disabled or unconfigured.
export async function getFrigateStatus(): Promise<{ enabled: boolean }> {
  const r = await fetch('/api/frigate/status', opts)
  if (!r.ok) return { enabled: false }
  return r.json()
}

export async function listPendingAnnouncements(): Promise<FrigateAnnouncement[]> {
  const r = await fetch('/api/frigate/announcements/pending', opts)
  if (!r.ok) throw new Error('failed')
  return ((await r.json()) as { items: FrigateAnnouncement[] }).items
}

// Claim an announcement before speaking. Returns true if THIS client won the claim.
export async function claimAnnouncement(id: string): Promise<boolean> {
  const r = await fetch(`/api/frigate/announcements/${id}/spoken`, { ...opts, method: 'POST' })
  if (!r.ok) return false
  return ((await r.json()) as { claimed: boolean }).claimed
}

export async function listEvents(limit = 50): Promise<FrigateEvent[]> {
  const r = await fetch(`/api/frigate/events?limit=${limit}`, opts)
  if (!r.ok) throw new Error('failed')
  return ((await r.json()) as { events: FrigateEvent[] }).events
}

// ── Admin config ──────────────────────────────────────────────────────────────
export async function getFrigateConfig(): Promise<FrigateConfig> {
  const r = await fetch('/api/admin/frigate/config', opts)
  if (!r.ok) throw new Error('failed')
  return r.json()
}

export async function saveFrigateConfig(patch: Record<string, unknown>): Promise<void> {
  const r = await fetch('/api/admin/frigate/config', { ...opts, method: 'PUT', headers: J, body: JSON.stringify(patch) })
  if (!r.ok) throw new Error('failed')
}

export async function generateShimToken(): Promise<string> {
  const r = await fetch('/api/admin/frigate/generate-token', { ...opts, method: 'POST' })
  if (!r.ok) throw new Error('failed')
  return ((await r.json()) as { token: string }).token
}

export async function testFrigate(): Promise<FrigateTestResult> {
  const r = await fetch('/api/admin/frigate/test', opts)
  if (!r.ok) throw new Error('failed')
  return r.json()
}
