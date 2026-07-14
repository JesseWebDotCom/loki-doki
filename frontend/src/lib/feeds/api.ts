// Typed wrappers around /api/feeds/*.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export interface Feed {
  id: string
  userId: string | null
  kind: 'rss' | 'atom' | 'search' | 'youtube'
  url: string | null
  title: string
  faviconUrl: string | null
  siteUrl: string | null
  folderId: string | null
  isSystem: boolean
  canEdit: boolean
  unread: number
  lastError: string | null
}
export interface FeedFolder { id: string; name: string; sortOrder: number }

export interface FeedItem {
  id: string
  feedId: string
  title: string
  url: string | null
  author: string | null
  summary: string | null
  imageUrl: string | null
  publishedAt: number | null
  feedTitle: string
  feedFavicon: string | null
  read: boolean
  saved: boolean
  score: number | null
}

export async function listFeeds(): Promise<{ feeds: Feed[]; folders: FeedFolder[] }> {
  const res = await fetch('/api/feeds', opts)
  if (!res.ok) throw new Error('Failed to load feeds')
  return res.json()
}

export interface ItemQuery { feedId?: string; folderId?: string; saved?: '1'; unread?: '1'; cursor?: number; limit?: number }
export async function listItems(q: ItemQuery = {}): Promise<{ items: FeedItem[]; nextCursor: number | null }> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v != null) params.set(k, String(v))
  const res = await fetch(`/api/feeds/items?${params}`, opts)
  if (!res.ok) throw new Error('Failed to load items')
  return res.json()
}

export async function discover(url: string): Promise<{ url: string; title: string | null; kind: string }[]> {
  const res = await fetch('/api/feeds/discover', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ url }) })
  return (await res.json()).candidates ?? []
}
export async function addFeed(body: { url?: string; feedUrl?: string; title?: string; query?: string; folderId?: string }): Promise<string> {
  const res = await fetch('/api/feeds', { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to add feed')
  return (await res.json()).id
}
export async function deleteFeed(id: string): Promise<void> {
  const res = await fetch(`/api/feeds/${id}`, { ...opts, method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove feed')
}
export async function refreshFeedApi(id: string): Promise<number> {
  const res = await fetch(`/api/feeds/${id}/refresh`, { ...opts, method: 'POST' })
  return (await res.json()).added ?? 0
}

export async function setItemState(id: string, body: { read?: boolean; saved?: boolean }): Promise<void> {
  await fetch(`/api/feeds/items/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(body) })
}
export async function markAllRead(scope: { feedId?: string; folderId?: string }): Promise<void> {
  await fetch('/api/feeds/items/read-all', { ...opts, method: 'POST', headers: J, body: JSON.stringify(scope) })
}

export interface FeedContent {
  id: string; title: string; url: string | null; author: string | null; siteName?: string | null
  contentHtml: string | null; readingMins: number; isObituary?: boolean
  /** contentHtml is just the feed's teaser (full article unreachable - bot-blocked/paywalled). */
  teaserOnly?: boolean
  /** Feed-provided lead image for the teaser view. */
  imageUrl?: string | null
  readerSource?: 'direct' | 'social' | 'subscriber' | 'browser' | 'ladder' | 'archive.is' | 'wayback' | null
  archiveUrl?: string | null
}
export async function getItemContent(id: string, options: { force?: boolean } = {}): Promise<FeedContent> {
  const res = await fetch(`/api/feeds/items/${id}/content${options.force ? '?force=1' : ''}`, opts)
  if (!res.ok) throw new Error('Failed to load article')
  return res.json()
}

// In-app reader content for a headline that has no feedItems row (News' local/global
// fallback cards) - extracted live from the URL instead of looked up by id.
export async function getArticleByUrl(url: string): Promise<FeedContent> {
  const res = await fetch(`/api/news/article?url=${encodeURIComponent(url)}`, opts)
  if (!res.ok) throw new Error('Failed to load article')
  return res.json()
}

// AI TL;DR for the reader's right-column summary panel: a short intro + a few key-fact bullets.
export interface ArticleSummary { intro: string; bullets: string[] }
export async function getItemSummary(id: string): Promise<{ summary: ArticleSummary | null }> {
  const res = await fetch(`/api/feeds/items/${id}/summary`, opts)
  if (!res.ok) throw new Error('Failed to load summary')
  return res.json()
}
export async function getArticleSummaryByUrl(url: string): Promise<{ summary: ArticleSummary | null }> {
  const res = await fetch(`/api/news/article/summary?url=${encodeURIComponent(url)}`, opts)
  if (!res.ok) throw new Error('Failed to load summary')
  return res.json()
}

export async function sendFeedback(id: string, vote: 'up' | 'down'): Promise<void> {
  await fetch(`/api/feeds/items/${id}/feedback`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ vote }) })
}

export async function importOpml(opml: string): Promise<number> {
  const res = await fetch('/api/feeds/opml/import', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ opml }) })
  return (await res.json()).imported ?? 0
}
