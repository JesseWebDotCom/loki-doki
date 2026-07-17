// Quick Connect client: a TV asks for a code and polls; a signed-in phone approves it.
// See backend/src/lib/quickConnect.ts for the model.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export interface QuickConnectPending { code: string; label: string; createdAt: number }

/** Ask for a code to display. Unauthenticated: this is the pre-login step. */
export async function startQuickConnect(label: string): Promise<{ code: string; expiresAt: number }> {
  const r = await fetch('/api/auth/quick-connect', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ label }) })
  if (!r.ok) throw new Error('Could not start sign-in')
  return await r.json() as { code: string; expiresAt: number }
}

/** Poll from the waiting device. 'approved' means our session cookie has been set. */
export async function pollQuickConnect(code: string): Promise<{ status: 'pending' | 'approved' | 'expired' }> {
  const r = await fetch(`/api/auth/quick-connect/${encodeURIComponent(code)}`, opts)
  if (!r.ok) return { status: 'expired' }
  return await r.json() as { status: 'pending' | 'approved' | 'expired' }
}

/** Codes waiting for someone to approve them (the approver's side). */
export async function listQuickConnects(): Promise<QuickConnectPending[]> {
  const r = await fetch('/api/auth/quick-connect', opts)
  if (!r.ok) return []
  return (await r.json() as { pending: QuickConnectPending[] }).pending ?? []
}

/** Approve a code as the signed-in user: that device becomes them. */
export async function approveQuickConnect(code: string): Promise<void> {
  const r = await fetch(`/api/auth/quick-connect/${encodeURIComponent(code)}/approve`, { ...opts, method: 'POST' })
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? 'That code is not valid anymore.')
  }
}
