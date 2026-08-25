// OPDS 1.2 server: exposes a user's Books library as an acquisition feed any OPDS
// reader (KOReader, Panels, Sutra, Chunky, …) can browse and download from. Auth is
// a per-user opaque token embedded in the feed URL (readers can't send our session
// cookie), stored in user_preferences. The feed and its acquisition/cover links all
// carry the same token, so a reader configured with one URL can pull everything.

import { randomUUID, randomBytes } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { books, bookLibrary, mediaAssets, userPreferences } from '@/db/schema'

const OPDS_TOKEN_PREF = 'books.opds_token'

export async function getOrCreateOpdsToken(userId: string): Promise<string> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, OPDS_TOKEN_PREF))).limit(1)
  if (row?.value) { try { return JSON.parse(row.value) as string } catch { /* regenerate */ } }
  const token = randomBytes(24).toString('base64url')
  const now = new Date()
  await db.insert(userPreferences).values({ id: randomUUID(), userId, key: OPDS_TOKEN_PREF, value: JSON.stringify(token), updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value: JSON.stringify(token), updatedAt: now } })
  return token
}

export async function resolveOpdsToken(token: string): Promise<string | null> {
  if (!token) return null
  const rows = await db.select({ userId: userPreferences.userId, value: userPreferences.value }).from(userPreferences)
    .where(eq(userPreferences.key, OPDS_TOKEN_PREF))
  for (const r of rows) {
    try { if (JSON.parse(r.value) === token) return r.userId } catch { /* skip */ }
  }
  return null
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

const ACQ_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition'
const MIME: Record<string, string> = { epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip' }

interface FeedBook {
  id: string; title: string; author: string | null; language: string | null
  seriesName: string | null; format: string; hasCover: boolean; updatedAt: Date
}

/** The user's downloadable library: ready ebook assets joined to catalog + membership. */
async function feedBooks(userId: string): Promise<FeedBook[]> {
  const rows = await db.select({
    id: books.id, title: books.title, author: books.author, language: books.language,
    seriesName: books.seriesName, format: mediaAssets.format, coverUrl: books.coverUrl, updatedAt: books.updatedAt,
  })
    .from(bookLibrary)
    .innerJoin(books, eq(bookLibrary.bookId, books.id))
    .innerJoin(mediaAssets, and(eq(mediaAssets.sourceType, 'book'), eq(mediaAssets.sourceId, books.id), eq(mediaAssets.kind, 'ebook'), eq(mediaAssets.status, 'ready')))
    .where(eq(bookLibrary.userId, userId))
    .orderBy(desc(bookLibrary.addedAt))
  return rows.map((r) => ({
    id: r.id, title: r.title, author: r.author, language: r.language, seriesName: r.seriesName,
    format: r.format, hasCover: Boolean(r.coverUrl) || r.format === 'epub', updatedAt: r.updatedAt ?? new Date(),
  }))
}

/** Build the OPDS 1.2 acquisition feed XML for a user's library. `base` is the
 *  absolute-or-relative path prefix for links, e.g. `/api/opds/<token>`. */
export async function buildOpdsFeed(userId: string, base: string): Promise<string> {
  const list = await feedBooks(userId)
  const updated = new Date().toISOString()
  const entries = list.map((b) => {
    const acqType = MIME[b.format] ?? 'application/octet-stream'
    const links = [
      b.hasCover ? `    <link rel="http://opds-spec.org/image/thumbnail" href="${base}/cover/${b.id}" type="image/jpeg"/>` : '',
      b.hasCover ? `    <link rel="http://opds-spec.org/image" href="${base}/cover/${b.id}" type="image/jpeg"/>` : '',
      `    <link rel="http://opds-spec.org/acquisition" href="${base}/download/${b.id}" type="${acqType}"/>`,
    ].filter(Boolean).join('\n')
    return [
      '  <entry>',
      `    <title>${xmlEscape(b.title)}</title>`,
      `    <id>urn:maipai:book:${b.id}</id>`,
      `    <updated>${b.updatedAt.toISOString()}</updated>`,
      b.author ? `    <author><name>${xmlEscape(b.author)}</name></author>` : '',
      b.language ? `    <dcterms:language>${xmlEscape(b.language)}</dcterms:language>` : '',
      b.seriesName ? `    <category term="${xmlEscape(b.seriesName)}" label="${xmlEscape(b.seriesName)}"/>` : '',
      links,
      '  </entry>',
    ].filter(Boolean).join('\n')
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:maipai:opds:${userId}</id>
  <title>My Library</title>
  <updated>${updated}</updated>
  <link rel="self" href="${base}" type="${ACQ_TYPE}"/>
  <link rel="start" href="${base}" type="${ACQ_TYPE}"/>
${entries}
</feed>`
}
