// Typed wrappers around /api/bookmarks/*.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export type BookmarkType = 'live' | 'offline'
export type BookmarkStatus = 'unread' | 'reading' | 'archived'
export type ArchiveState = 'none' | 'pending' | 'fetching' | 'ready' | 'failed'
export type WatchMode = 'any_change' | 'keyword_appears' | 'keyword_disappears' | 'number_below' | 'number_above'

export interface BookmarkItem {
  id: string
  ownerId: string | null
  source: 'bookmark' | 'article' | 'feed'
  sourceRef: string | null
  type: BookmarkType
  url: string
  title: string
  byline: string | null
  siteName: string | null
  faviconUrl: string | null
  excerpt: string | null
  contentHtml?: string | null
  snapshotPath?: string | null
  ogImagePath?: string | null
  pdfPath: string | null
  mediaPath: string | null
  captureMedia: boolean
  archiveOrgUrl: string | null
  wordCount: number
  readingMins: number
  status: BookmarkStatus
  archiveState: ArchiveState
  archiveError: string | null
  useProxy: boolean
  useEmbed: boolean
  category: string
  collectionId: string | null
  autoUpdate: boolean
  autoUpdateIntervalMins: number | null
  alertOnChange: boolean
  lastCheckedAt: string | null
  contentChangedAt: string | null
  watchSelector: string | null
  watchMode: WatchMode
  watchKeyword: string | null
  watchThreshold: number | null
  lastWatchValue: string | null
  createdAt: string
  updatedAt: string
  tags: string[]
  isGlobal: boolean
  canEdit: boolean
  isHidden: boolean
}

export interface BookmarkCollection { id: string; ownerId: string | null; name: string; icon: string | null; color: string | null; sortOrder: number }
export interface BookmarkTag { id: string; ownerId: string | null; name: string }

export interface ListParams {
  status?: BookmarkStatus
  type?: BookmarkType
  collectionId?: string
  tag?: string
  q?: string
}

export async function listItems(params: ListParams = {}): Promise<BookmarkItem[]> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString()
  const res = await fetch(`/api/bookmarks${qs ? `?${qs}` : ''}`, opts)
  if (!res.ok) throw new Error('Failed to load items')
  return (await res.json()).items
}

export async function getItem(id: string): Promise<BookmarkItem> {
  const res = await fetch(`/api/bookmarks/${id}`, opts)
  if (!res.ok) throw new Error('Failed to load item')
  return (await res.json()).item
}

export interface CreateBody {
  type: BookmarkType
  url: string
  title?: string
  faviconUrl?: string
  collectionId?: string
  collectionName?: string
  tags?: string[]
  category?: string
  useProxy?: boolean
  useEmbed?: boolean
  captureMedia?: boolean
  /** Admin only: save as a global bookmark visible to everyone (ownerId = null). */
  makeGlobal?: boolean
}
export async function createItem(body: CreateBody): Promise<BookmarkItem> {
  const res = await fetch('/api/bookmarks', { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('Failed to save')
  return (await res.json()).item
}

export async function updateItem(id: string, body: Partial<{ title: string; status: BookmarkStatus; collectionId: string | null; tags: string[]; category: string; useProxy: boolean; useEmbed: boolean; autoUpdate: boolean; autoUpdateIntervalMins: number | null; alertOnChange: boolean; captureMedia: boolean; makeGlobal: boolean; watchSelector: string | null; watchMode: WatchMode; watchKeyword: string | null; watchThreshold: number | null }>): Promise<void> {
  const res = await fetch(`/api/bookmarks/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('Failed to update')
}

export async function deleteItem(id: string): Promise<void> {
  const res = await fetch(`/api/bookmarks/${id}`, { ...opts, method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete')
}

export async function rearchiveItem(id: string): Promise<void> {
  const res = await fetch(`/api/bookmarks/${id}/rearchive`, { ...opts, method: 'POST' })
  if (!res.ok) throw new Error('Failed to re-archive')
}

export interface ProbeResult { reachable: boolean; framesBlocked: boolean; faviconUrl: string | null; title: string | null }
export async function probe(url: string): Promise<ProbeResult> {
  const res = await fetch(`/api/bookmarks/probe?url=${encodeURIComponent(url)}`, opts)
  if (!res.ok) return { reachable: false, framesBlocked: false, faviconUrl: null, title: null }
  return res.json()
}

export async function listCollections(): Promise<BookmarkCollection[]> {
  const res = await fetch('/api/bookmarks/collections', opts)
  if (!res.ok) throw new Error('Failed to load collections')
  return (await res.json()).collections
}
export async function createCollection(name: string): Promise<string> {
  const res = await fetch('/api/bookmarks/collections', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name }) })
  if (!res.ok) throw new Error('Failed to create collection')
  return (await res.json()).id
}
export async function updateCollection(id: string, body: Partial<{ name: string; icon: string | null; color: string | null; sortOrder: number }>): Promise<void> {
  const res = await fetch(`/api/bookmarks/collections/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('Failed to update collection')
}
export async function deleteCollection(id: string): Promise<void> {
  const res = await fetch(`/api/bookmarks/collections/${id}`, { ...opts, method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete collection')
}

export async function listTags(): Promise<BookmarkTag[]> {
  const res = await fetch('/api/bookmarks/tags', opts)
  if (!res.ok) throw new Error('Failed to load tags')
  return (await res.json()).tags
}

export async function importBookmarksHtml(html: string): Promise<number> {
  const res = await fetch('/api/bookmarks/import/html', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ html }) })
  if (!res.ok) throw new Error('Import failed')
  return (await res.json()).imported
}

// Unified importer — auto-detects Netscape HTML, JSON (Pinboard/Pocket/array), or CSV.
export async function importBookmarks(data: string, format: 'auto' | 'html' | 'json' | 'csv' = 'auto'): Promise<number> {
  const res = await fetch('/api/bookmarks/import', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ data, format }) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Import failed')
  return (await res.json()).imported
}

export async function setHidden(id: string, hidden: boolean): Promise<void> {
  await fetch(`/api/bookmarks/hide/${id}`, { ...opts, method: hidden ? 'PUT' : 'DELETE' })
}

// ── Version history (snapshots) ──
// ── Highlights & notes ─────────────────────────────────────────────────────────

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export interface Highlight {
  id: string
  bookmarkId: string
  kind: 'highlight' | 'note'
  quote: string
  prefix: string
  suffix: string
  color: HighlightColor
  note: string | null
  createdAt: string
  updatedAt: string
}

export async function listHighlights(id: string): Promise<Highlight[]> {
  const r = await fetch(`/api/bookmarks/${id}/highlights`, opts)
  if (!r.ok) return []
  return ((await r.json()) as { items: Highlight[] }).items
}

export async function createHighlight(id: string, body: {
  kind?: 'highlight' | 'note'; quote?: string; prefix?: string; suffix?: string; color?: HighlightColor; note?: string
}): Promise<Highlight> {
  const r = await fetch(`/api/bookmarks/${id}/highlights`, { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  if (!r.ok) throw new Error('Failed to save highlight')
  return ((await r.json()) as { item: Highlight }).item
}

export async function updateHighlight(id: string, hid: string, body: { color?: HighlightColor; note?: string | null }): Promise<void> {
  await fetch(`/api/bookmarks/${id}/highlights/${hid}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(body) })
}

export async function deleteHighlight(id: string, hid: string): Promise<void> {
  await fetch(`/api/bookmarks/${id}/highlights/${hid}`, { ...opts, method: 'DELETE' })
}

export interface BookmarkSnapshotMeta { id: string; capturedAt: string; title: string | null; wordCount: number; changed: boolean; watchValue: string | null }
export interface BookmarkSnapshot extends BookmarkSnapshotMeta { contentHtml: string | null; contentText: string | null; contentHash: string | null; bookmarkId: string }

export async function listSnapshots(id: string): Promise<BookmarkSnapshotMeta[]> {
  const res = await fetch(`/api/bookmarks/${id}/snapshots`, opts)
  if (!res.ok) throw new Error('Failed to load history')
  return (await res.json()).snapshots
}
export async function getSnapshot(id: string, snapId: string): Promise<BookmarkSnapshot> {
  const res = await fetch(`/api/bookmarks/${id}/snapshots/${snapId}`, opts)
  if (!res.ok) throw new Error('Failed to load version')
  return (await res.json()).snapshot
}

/** Archive-relative asset URL (PDF, captured media, etc.) served from the snapshot dir. */
export function archiveAssetUrl(id: string, rel: string): string {
  return `/api/bookmarks/${id}/archive/${rel}`
}

export async function summarizeItem(id: string): Promise<{ summary: string; tags: string[] }> {
  const res = await fetch(`/api/bookmarks/${id}/summarize`, { ...opts, method: 'POST' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Summarize failed')
  return res.json()
}

export async function askItem(id: string, question: string): Promise<string> {
  const res = await fetch(`/api/bookmarks/${id}/ask`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ question }) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Ask failed')
  return (await res.json()).answer
}
