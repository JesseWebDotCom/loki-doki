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
  isPinned: boolean
  contentKind: 'link' | 'pdf' | 'image'
  uploadPath: string | null
}

export type CollectionRole = 'owner' | 'editor' | 'viewer'
export interface BookmarkCollection {
  id: string; ownerId: string | null; name: string; icon: string | null; color: string | null; sortOrder: number
  parentId: string | null
  isPublic: boolean
  publicSlug: string | null
  rssUrl: string | null
  rssAutoTag: boolean
  role: CollectionRole
  linkCount: number
  ownerName: string | null
}
export interface BookmarkTag { id: string; ownerId: string | null; name: string; count: number }
export interface CollectionMember { id: string; userId: string; role: 'viewer' | 'editor'; name: string }

export type BookmarkSort = 'newest' | 'oldest' | 'title' | '-title' | 'updated'

export interface ListParams {
  status?: BookmarkStatus
  type?: BookmarkType
  collectionId?: string
  tag?: string
  q?: string
  sort?: BookmarkSort
  pinned?: '1'
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

export async function updateItem(id: string, body: Partial<{ title: string; status: BookmarkStatus; collectionId: string | null; tags: string[]; category: string; useProxy: boolean; useEmbed: boolean; isPinned: boolean; autoUpdate: boolean; autoUpdateIntervalMins: number | null; alertOnChange: boolean; captureMedia: boolean; makeGlobal: boolean; watchSelector: string | null; watchMode: WatchMode; watchKeyword: string | null; watchThreshold: number | null }>): Promise<void> {
  const res = await fetch(`/api/bookmarks/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('Failed to update')
}

// Bulk actions over the user's own items.
export type BulkAction = 'archive' | 'unarchive' | 'delete' | 'pin' | 'unpin' | 'move' | 'addTags'
export async function bulkAction(ids: string[], action: BulkAction, extra: { collectionId?: string | null; tags?: string[] } = {}): Promise<number> {
  const res = await fetch('/api/bookmarks/bulk', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ ids, action, ...extra }) })
  if (!res.ok) throw new Error('Bulk action failed')
  return (await res.json()).affected
}

// Upload a PDF or image file as a bookmark.
export async function uploadFile(file: File, extra: { title?: string; collectionId?: string | null } = {}): Promise<BookmarkItem> {
  const fd = new FormData()
  fd.append('file', file)
  if (extra.title) fd.append('title', extra.title)
  if (extra.collectionId) fd.append('collectionId', extra.collectionId)
  const res = await fetch('/api/bookmarks/upload', { ...opts, method: 'POST', body: fd })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed')
  return (await res.json()).item
}

// AI auto-tag with a chosen strategy.
export type AutoTagMode = 'generate' | 'existing' | 'predefined'
export async function autoTagItem(id: string, mode: AutoTagMode = 'generate', candidates?: string[]): Promise<string[]> {
  const res = await fetch(`/api/bookmarks/${id}/autotag`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ mode, candidates }) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Auto-tag failed')
  return (await res.json()).tags
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
export async function createCollection(name: string, parentId?: string | null): Promise<string> {
  const res = await fetch('/api/bookmarks/collections', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name, parentId }) })
  if (!res.ok) throw new Error('Failed to create collection')
  return (await res.json()).id
}
export async function updateCollection(id: string, body: Partial<{ name: string; icon: string | null; color: string | null; sortOrder: number; parentId: string | null; isPublic: boolean; rssUrl: string | null; rssAutoTag: boolean }>): Promise<{ publicSlug: string | null }> {
  const res = await fetch(`/api/bookmarks/collections/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to update collection')
  return res.json()
}
export async function deleteCollection(id: string): Promise<void> {
  const res = await fetch(`/api/bookmarks/collections/${id}`, { ...opts, method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete collection')
}

// ── Collection collaborators ──
export async function listMembers(id: string): Promise<CollectionMember[]> {
  const res = await fetch(`/api/bookmarks/collections/${id}/members`, opts)
  if (!res.ok) throw new Error('Failed to load members')
  return (await res.json()).members
}
export async function addMember(id: string, userId: string, role: 'viewer' | 'editor'): Promise<void> {
  const res = await fetch(`/api/bookmarks/collections/${id}/members`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ userId, role }) })
  if (!res.ok) throw new Error('Failed to add member')
}
export async function removeMember(id: string, userId: string): Promise<void> {
  await fetch(`/api/bookmarks/collections/${id}/members/${userId}`, { ...opts, method: 'DELETE' })
}

export async function listTags(): Promise<BookmarkTag[]> {
  const res = await fetch('/api/bookmarks/tags', opts)
  if (!res.ok) throw new Error('Failed to load tags')
  return (await res.json()).tags
}
export async function renameTag(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/bookmarks/tags/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify({ name }) })
  if (!res.ok) throw new Error('Failed to rename tag')
}
export async function deleteTag(id: string): Promise<void> {
  const res = await fetch(`/api/bookmarks/tags/${id}`, { ...opts, method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete tag')
}
export async function mergeTags(sourceIds: string[], targetId: string): Promise<void> {
  const res = await fetch('/api/bookmarks/tags/merge', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ sourceIds, targetId }) })
  if (!res.ok) throw new Error('Failed to merge tags')
}

// ── Home / dashboard ──
export interface BookmarkStats { total: number; live: number; offline: number; collections: number; tags: number }
export interface BookmarkHome { stats: BookmarkStats; pinned: BookmarkItem[]; recent: BookmarkItem[] }
export async function getHome(): Promise<BookmarkHome> {
  const res = await fetch('/api/bookmarks/home', opts)
  if (!res.ok) throw new Error('Failed to load dashboard')
  return res.json()
}

// Household profiles (for the collaborator picker). Reuses the unauthenticated profile list.
export interface HouseholdProfile { id: string; nickname: string; avatarUrl: string | null }
export async function listHouseholdProfiles(): Promise<HouseholdProfile[]> {
  const res = await fetch('/api/auth/profiles', opts)
  if (!res.ok) return []
  return (await res.json()).map((p: { id: string; nickname: string; avatarUrl: string | null }) => ({ id: p.id, nickname: p.nickname, avatarUrl: p.avatarUrl }))
}

// ── Public shared collection (no auth) ──
export interface PublicCollection {
  collection: { name: string; icon: string | null; color: string | null }
  items: { id: string; url: string; title: string; excerpt: string | null; siteName: string | null; faviconUrl: string | null; createdAt: string | null }[]
}
export async function getPublicCollection(slug: string): Promise<PublicCollection> {
  const res = await fetch(`/api/bookmarks/public/${slug}`)
  if (!res.ok) throw new Error('Not found')
  return res.json()
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
