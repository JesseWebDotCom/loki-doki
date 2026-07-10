// Uptime Kuma integration API client (admin config + connection test).

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export interface MonitoringConfig {
  enabled: boolean
  announceEnabled: boolean
  notifyOn: string[]
  cooldownMinutes: number
  criticalMonitors: string[]
  reconcileEnabled: boolean
  reconcileMinutes: number
  baseUrl: string
  apiKeySet: boolean
  webhookTokenSet: boolean
  /** Full URL (with token) to paste into Kuma's Webhook notification. Null until a token is generated. */
  webhookUrl: string | null
  allMonitorEvents: string[]
}

export interface MonitorState {
  name: string
  status: number  // 0 down, 1 up, 2 pending, 3 maintenance
  up: boolean
}

export interface MonitoringTestResult {
  ok: boolean
  count?: number
  monitors?: MonitorState[]
  error?: string
}

export async function getMonitoringConfig(): Promise<MonitoringConfig> {
  const r = await fetch('/api/admin/monitoring/config', opts)
  if (!r.ok) throw new Error('failed')
  return r.json()
}

export async function saveMonitoringConfig(patch: Record<string, unknown>): Promise<void> {
  const r = await fetch('/api/admin/monitoring/config', { ...opts, method: 'PUT', headers: J, body: JSON.stringify(patch) })
  if (!r.ok) throw new Error('failed')
}

export async function generateWebhookToken(): Promise<string> {
  const r = await fetch('/api/admin/monitoring/generate-token', { ...opts, method: 'POST' })
  if (!r.ok) throw new Error('failed')
  return ((await r.json()) as { token: string }).token
}

export async function testMonitoring(): Promise<MonitoringTestResult> {
  const r = await fetch('/api/admin/monitoring/test', opts)
  if (!r.ok) throw new Error('failed')
  return r.json()
}

// ── Spoken announcements (any authenticated client polls + speaks) ─────────────

export async function getMonitoringStatus(): Promise<{ enabled: boolean }> {
  const r = await fetch('/api/monitoring/status', opts)
  if (!r.ok) return { enabled: false }
  return r.json()
}

export interface MonitoringAnnouncement { id: string; text: string }

export async function listPendingMonitoringAnnouncements(): Promise<MonitoringAnnouncement[]> {
  const r = await fetch('/api/monitoring/announcements/pending', opts)
  if (!r.ok) throw new Error('failed')
  return ((await r.json()) as { items: MonitoringAnnouncement[] }).items
}

// Claim a line before speaking; true if THIS client won the claim.
export async function claimMonitoringAnnouncement(id: string): Promise<boolean> {
  const r = await fetch(`/api/monitoring/announcements/${id}/spoken`, { ...opts, method: 'POST' })
  if (!r.ok) return false
  return ((await r.json()) as { claimed: boolean }).claimed
}
