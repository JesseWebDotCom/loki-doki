// Apple iCloud integration API client (admin account management).

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export type ICloudProbeStatus = 'ok' | 'auth_error' | 'error' | 'unprobed'

export interface ICloudAccount {
  id: string
  userId: string
  userNickname: string
  appleId: string
  caldavStatus: ICloudProbeStatus
  imapStatus: ICloudProbeStatus
  lastProbeAt: string | null
  lastError: string | null
  createdAt: string
}

async function unwrap<T>(r: Response, key: string): Promise<T> {
  const body = await r.json().catch(() => null) as Record<string, unknown> | null
  if (!r.ok) throw new Error((body?.error as string) || 'Request failed')
  return body?.[key] as T
}

export async function listICloudAccounts(): Promise<ICloudAccount[]> {
  return unwrap(await fetch('/api/icloud/accounts', opts), 'accounts')
}

export async function connectICloudAccount(input: { userId: string; appleId: string; appPassword: string }): Promise<ICloudAccount> {
  const r = await fetch('/api/icloud/accounts', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  return unwrap(r, 'account')
}

export async function probeICloudAccount(id: string): Promise<ICloudAccount> {
  const r = await fetch(`/api/icloud/accounts/${id}/probe`, { ...opts, method: 'POST' })
  return unwrap(r, 'account')
}

/** Reconnect with a fresh app-specific password. */
export async function reconnectICloudAccount(id: string, appPassword: string): Promise<ICloudAccount> {
  const r = await fetch(`/api/icloud/accounts/${id}`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ appPassword }) })
  return unwrap(r, 'account')
}

export async function disconnectICloudAccount(id: string): Promise<void> {
  const r = await fetch(`/api/icloud/accounts/${id}`, { ...opts, method: 'DELETE' })
  if (!r.ok) throw new Error('Request failed')
}
