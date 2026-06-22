// Typed wrappers around /api/reader/*.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export type ReaderType = 'live' | 'offline'
export type ReaderStatus = 'unread' | 'reading' | 'archived'
export type ArchiveState = 'none' | 'pending' | 'fetching' | 'ready' | 'failed'

export interface ReaderItem {
  id: string
  ownerId: string | null
  source: 'bookmark' | 'article' | 'feed'
  sourceRef: string | null
  type: ReaderType
  url: string
  title: string
  byline: string | null
  siteName: string | null
  faviconUrl: string | null
  excerpt: string | null
  contentHtml?: string | null
  wordCount: number
  readingMins: number
  status: ReaderStatus
  archiveState: ArchiveState
  archiveError: string | null
  useProxy: boolean
  useEmbed: boolean
  category: string
  collectionId: string | null
  createdAt: string
  updatedAt: string
  tags: string[]
  isGlobal: boolean
  canEdit: boolean
  isHidden: boolean
}

export interface ReaderCollection { id: string; ownerId: string | null; name: string; sortOrder: number }
export interface ReaderTag { id: string; ownerId: string | null; name: string }

export interface ListParams {
  status?: ReaderStatus
  type?: ReaderType
  collectionId?: string
  tag?: string
  q?: string
}

export async function listItems(params: ListParams = {}): Promise<ReaderItem[]> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString()
  const res = await fetch(`/api/reader${qs ? `?${qs}` : ''}`, opts)
  if (!res.ok) throw new Error('Failed to load items')
  return (await res.json()).items
}

export async function getItem(id: string): Promise<ReaderItem> {
  const res = await fetch(`/api/reader/${id}`, opts)
  if (!res.ok) throw new Error('Failed to load item')
  return (await res.json()).item
}

export interface CreateBody {
  type: ReaderType
  url: string
  title?: string
  faviconUrl?: string
  collectionId?: string
  collectionName?: string
  tags?: string[]
  category?: string
  useProxy?: boolean
  useEmbed?: boolean
}
export async function createItem(body: CreateBody): Promise<ReaderItem> {
  const res = await fetch('/api/reader', { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('Failed to save')
  return (await res.json()).item
}

export async function updateItem(id: string, body: Partial<{ title: string; status: ReaderStatus; collectionId: string | null; tags: string[]; category: string; useProxy: boolean; useEmbed: boolean }>): Promise<void> {
  const res = await fetch(`/api/reader/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('Failed to update')
}

export async function deleteItem(id: string): Promise<void> {
  const res = await fetch(`/api/reader/${id}`, { ...opts, method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete')
}

export async function rearchiveItem(id: string): Promise<void> {
  const res = await fetch(`/api/reader/${id}/rearchive`, { ...opts, method: 'POST' })
  if (!res.ok) throw new Error('Failed to re-archive')
}

export interface ProbeResult { reachable: boolean; framesBlocked: boolean; faviconUrl: string | null; title: string | null }
export async function probe(url: string): Promise<ProbeResult> {
  const res = await fetch(`/api/reader/probe?url=${encodeURIComponent(url)}`, opts)
  if (!res.ok) return { reachable: false, framesBlocked: false, faviconUrl: null, title: null }
  return res.json()
}

export async function listCollections(): Promise<ReaderCollection[]> {
  const res = await fetch('/api/reader/collections', opts)
  if (!res.ok) throw new Error('Failed to load collections')
  return (await res.json()).collections
}
export async function createCollection(name: string): Promise<string> {
  const res = await fetch('/api/reader/collections', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name }) })
  if (!res.ok) throw new Error('Failed to create collection')
  return (await res.json()).id
}

export async function listTags(): Promise<ReaderTag[]> {
  const res = await fetch('/api/reader/tags', opts)
  if (!res.ok) throw new Error('Failed to load tags')
  return (await res.json()).tags
}

export async function importBookmarksHtml(html: string): Promise<number> {
  const res = await fetch('/api/reader/import/html', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ html }) })
  if (!res.ok) throw new Error('Import failed')
  return (await res.json()).imported
}

export async function setHidden(id: string, hidden: boolean): Promise<void> {
  await fetch(`/api/reader/hide/${id}`, { ...opts, method: hidden ? 'PUT' : 'DELETE' })
}

export async function summarizeItem(id: string): Promise<{ summary: string; tags: string[] }> {
  const res = await fetch(`/api/reader/${id}/summarize`, { ...opts, method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Summarize failed')
  return res.json()
}

export async function askItem(id: string, question: string): Promise<string> {
  const res = await fetch(`/api/reader/${id}/ask`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ question }) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Ask failed')
  return (await res.json()).answer
}
