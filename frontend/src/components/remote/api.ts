// Client for the Remote app API (backend: routes/remote.ts). All authenticated users.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }
const BASE = '/api/remote'

export interface HostSsh { port: number; user: string; auth: 'password' | 'key'; hasSecret: boolean }
export interface HostVnc { port: number; hasSecret: boolean }
export interface HostRdp { port: number; user: string; security: 'nla' | 'tls' | 'rdp' | null; hasSecret: boolean }

export interface RemoteHost {
  id: string
  label: string
  hostname: string
  shared: boolean
  owned: boolean
  canManage: boolean
  folderId: string | null
  favorite: boolean
  sortOrder: number
  ssh: HostSsh | null
  vnc: HostVnc | null
  rdp: HostRdp | null
}

export interface HostInput {
  label: string
  hostname: string
  shared?: boolean
  folderId?: string | null
  ssh?: { port?: number; user?: string; auth?: 'password' | 'key'; secret?: string } | null
  vnc?: { port?: number; secret?: string } | null
  rdp?: { port?: number; user?: string; security?: 'nla' | 'tls' | 'rdp'; secret?: string } | null
}

export interface RemoteFolder { id: string; ownerId: string | null; parentId: string | null; name: string; icon: string | null; color: string | null; sortOrder: number; shared: boolean; canManage: boolean }
export interface RemoteSnippet { id: string; ownerId: string | null; name: string; command: string; shared: boolean; canManage: boolean }
export interface Capabilities { sandboxInstalled: boolean; isWin: boolean; isAdmin: boolean }
export interface SftpEntry { name: string; dir: boolean; size: number; mtime: number }

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, opts)
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json() as Promise<T>
}
async function jsend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { ...opts, method, headers: J, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = ((await r.json()) as { error?: string }).error ?? msg } catch { /* non-json */ }
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}

export const getCapabilities = () => jget<Capabilities>('/capabilities')

export const getHosts = () => jget<{ hosts: RemoteHost[] }>('/hosts').then((r) => r.hosts)
export const createHost = (b: HostInput) => jsend<{ host: RemoteHost }>('/hosts', 'POST', b).then((r) => r.host)
export const updateHost = (id: string, b: HostInput) => jsend<{ host: RemoteHost }>(`/hosts/${id}`, 'PUT', b).then((r) => r.host)
export const deleteHost = (id: string) => jsend<{ ok: boolean }>(`/hosts/${id}`, 'DELETE')
export const setFavorite = (hostId: string, on: boolean) => jsend<{ ok: boolean }>(`/favorites/${hostId}`, 'PUT', { on })

export const getFolders = () => jget<{ folders: RemoteFolder[] }>('/folders').then((r) => r.folders)
export const createFolder = (b: { name: string; parentId?: string | null; icon?: string; color?: string; shared?: boolean }) => jsend<{ id: string }>('/folders', 'POST', b)
export const updateFolder = (id: string, b: { name?: string; parentId?: string | null; sortOrder?: number }) => jsend<{ ok: boolean }>(`/folders/${id}`, 'PUT', b)
export const deleteFolder = (id: string) => jsend<{ ok: boolean }>(`/folders/${id}`, 'DELETE')

export const getSnippets = () => jget<{ snippets: RemoteSnippet[] }>('/snippets').then((r) => r.snippets)
export const createSnippet = (b: { name: string; command: string; shared?: boolean }) => jsend<{ id: string }>('/snippets', 'POST', b)
export const deleteSnippet = (id: string) => jsend<{ ok: boolean }>(`/snippets/${id}`, 'DELETE')

export const authorizeHostShell = (pin: string) => jsend<{ token: string }>('/host-shell/authorize', 'POST', { pin }).then((r) => r.token)

export interface VncCreds { password: string }
export interface RdpCreds { username: string; password: string; security: string }
export const getVncCreds = (host: string) => jget<VncCreds>(`/display-credentials?proto=vnc&host=${encodeURIComponent(host)}`)
export const getRdpCreds = (host: string) => jget<RdpCreds>(`/display-credentials?proto=rdp&host=${encodeURIComponent(host)}`)

// SFTP
export const sftpList = (host: string, path: string) => jget<{ path: string; entries: SftpEntry[] }>(`/sftp/list?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`)
export const sftpDownloadUrl = (host: string, path: string) => `${BASE}/sftp/download?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`
export async function sftpUpload(host: string, remotePath: string, file: File): Promise<void> {
  const r = await fetch(`${BASE}/sftp/upload?host=${encodeURIComponent(host)}&path=${encodeURIComponent(remotePath)}`, { ...opts, method: 'POST', body: file })
  if (!r.ok) throw new Error(`upload failed (${r.status})`)
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${BASE}${path}`
}
