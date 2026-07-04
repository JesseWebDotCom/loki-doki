// Client helpers for the Drop app (device-to-device transfer). This holds the stable
// per-device identity (persisted in localStorage) that both the receiver hook and the
// Drop page share, plus thin fetch wrappers over /api/drop.

const opts: RequestInit = { credentials: 'include' }

export interface DropPreview {
  id: string
  kind: 'file' | 'text'
  fileName?: string | null
  mime?: string | null
  sizeBytes?: number | null
  body?: string | null
  senderLabel: string
  createdAt: number
}

export interface DropDevice {
  deviceId: string
  label: string
}

// ── Stable device identity ──────────────────────────────────────────────────
const ID_KEY = 'drop.deviceId'

/** A stable id for THIS browser, minted once and kept in localStorage. */
export function getDeviceId(): string {
  let id = ''
  try { id = localStorage.getItem(ID_KEY) || '' } catch { /* private mode */ }
  if (!id) {
    id = (crypto.randomUUID?.() || `${Date.now()}-${Math.round(Math.random() * 1e9)}`)
    try { localStorage.setItem(ID_KEY, id) } catch { /* ignore */ }
  }
  return id
}

/** A friendly "Chrome · macOS" label derived from the user agent, for the picker. */
export function getDeviceLabel(): string {
  const ua = navigator.userAgent
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Android/.test(ua) ? 'Android' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} · ${os}` : browser
}

// ── API ──────────────────────────────────────────────────────────────────────
export async function listDropDevices(): Promise<DropDevice[]> {
  const r = await fetch(`/api/drop/devices?self=${encodeURIComponent(getDeviceId())}`, opts)
  if (!r.ok) return []
  return ((await r.json()) as { devices: DropDevice[] }).devices
}

export async function getInbox(): Promise<DropPreview[]> {
  const r = await fetch(`/api/drop/inbox?deviceId=${encodeURIComponent(getDeviceId())}`, opts)
  if (!r.ok) return []
  return ((await r.json()) as { drops: DropPreview[] }).drops
}

/** Send a file to a device (or targetDeviceId=null → all my other devices). */
export async function sendFile(file: File, targetDeviceId: string | null): Promise<Response> {
  const form = new FormData()
  form.set('kind', 'file')
  form.set('senderDeviceId', getDeviceId())
  form.set('senderLabel', getDeviceLabel())
  if (targetDeviceId) form.set('targetDeviceId', targetDeviceId)
  form.set('file', file)
  return fetch('/api/drop/send', { ...opts, method: 'POST', body: form })
}

/** Send a text/link snippet. */
export async function sendText(body: string, targetDeviceId: string | null): Promise<Response> {
  const form = new FormData()
  form.set('kind', 'text')
  form.set('senderDeviceId', getDeviceId())
  form.set('senderLabel', getDeviceLabel())
  form.set('body', body)
  if (targetDeviceId) form.set('targetDeviceId', targetDeviceId)
  return fetch('/api/drop/send', { ...opts, method: 'POST', body: form })
}

/** Trigger a browser download of a received file drop (cookie-authed same-origin GET). */
export function downloadDrop(d: DropPreview): void {
  const a = document.createElement('a')
  a.href = `/api/drop/${d.id}/blob`
  a.download = d.fileName || 'file'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export async function dismissDrop(id: string): Promise<void> {
  await fetch(`/api/drop/${id}/dismiss`, { ...opts, method: 'POST' }).catch(() => {})
}

export function formatBytes(n?: number | null): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
