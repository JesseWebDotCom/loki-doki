// User-configured self-hosted OPDS indexers (Calibre-Web, Kavita, COPS, etc.) —
// the escape hatch for anything beyond Gutenberg/Archive.org/LibriVox's built-in
// catalogs. Multiple allowed (bookIndexers table), admin-managed (Admin >
// Integrations > Books). Superseded an earlier single-slot design that lived in
// tool_global_config (toolId: 'bookIndexer') — that table is no longer read.
//
// Deliberately uses plain `fetch`, NOT `lib/ssrfGuard`'s safeFetch: the SSRF guard
// blocks private/LAN addresses, but a self-hosted OPDS server is almost always ON
// the LAN (e.g. a Calibre-Web instance at 192.168.x.x) — exactly what
// `backend/src/lib/homeAssistant/client.ts` does for the same reason (an
// admin-configured internal destination is trusted, unlike an arbitrary
// user-supplied URL elsewhere in the app).

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bookIndexers } from '@/db/schema'
import { parseOpdsFeed } from './opds'
import type { BookSearchResult, ResolvedDownload } from './types'

export interface BookIndexer {
  id: string
  label: string
  baseUrl: string
  username: string | null
  hasPassword: boolean
  enabled: boolean
}

function toPublic(row: typeof bookIndexers.$inferSelect): BookIndexer {
  return { id: row.id, label: row.label, baseUrl: row.baseUrl, username: row.username, hasPassword: !!row.password, enabled: row.enabled }
}

export async function listIndexers(): Promise<BookIndexer[]> {
  const rows = await db.select().from(bookIndexers)
  return rows.map(toPublic)
}

export async function createIndexer(input: { label: string; baseUrl: string; username?: string | null; password?: string | null; enabled?: boolean }): Promise<BookIndexer> {
  const now = new Date()
  const row = {
    id: randomUUID(), label: input.label.trim(), baseUrl: input.baseUrl.trim(),
    username: input.username?.trim() || null, password: input.password?.trim() || null,
    enabled: input.enabled ?? true, createdAt: now, updatedAt: now,
  }
  await db.insert(bookIndexers).values(row)
  return toPublic(row)
}

export async function updateIndexer(id: string, patch: { label?: string; baseUrl?: string; username?: string | null; password?: string | null; enabled?: boolean }): Promise<void> {
  const set: Partial<typeof bookIndexers.$inferInsert> = { updatedAt: new Date() }
  if (patch.label !== undefined) set.label = patch.label.trim()
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl.trim()
  if (patch.username !== undefined) set.username = patch.username?.trim() || null
  if (patch.password) set.password = patch.password.trim() // empty string means "leave unchanged"
  if (patch.enabled !== undefined) set.enabled = patch.enabled
  await db.update(bookIndexers).set(set).where(eq(bookIndexers.id, id))
}

export async function deleteIndexer(id: string): Promise<void> {
  await db.delete(bookIndexers).where(eq(bookIndexers.id, id))
}

async function getIndexerRow(id: string): Promise<typeof bookIndexers.$inferSelect | null> {
  const [row] = await db.select().from(bookIndexers).where(eq(bookIndexers.id, id)).limit(1)
  return row ?? null
}

function authHeaders(row: typeof bookIndexers.$inferSelect): Record<string, string> {
  if (!row.username) return {}
  const token = Buffer.from(`${row.username}:${row.password ?? ''}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

/** Build the search URL: supports the OpenSearch `{searchTerms}` placeholder
 *  convention (what most OPDS servers document for their search feed), falling
 *  back to a plain `?q=` query param appended to the configured base URL. */
function buildSearchUrl(row: typeof bookIndexers.$inferSelect, query: string): string {
  if (row.baseUrl.includes('{searchTerms}')) return row.baseUrl.replace('{searchTerms}', encodeURIComponent(query))
  const sep = row.baseUrl.includes('?') ? '&' : '?'
  return `${row.baseUrl}${sep}q=${encodeURIComponent(query)}`
}

async function searchOneIndexer(row: typeof bookIndexers.$inferSelect, query: string): Promise<BookSearchResult[]> {
  try {
    const res = await fetch(buildSearchUrl(row, query), {
      headers: { Accept: 'application/atom+xml, application/xml, text/xml', ...authHeaders(row) },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const results = parseOpdsFeed(await res.text(), res.url)
    // Composite key so resolveIndexerDownload knows which indexer (and therefore
    // which auth) a result came from — each indexer's acquisition URLs otherwise
    // look identical (a bare URL string) once merged into one result list.
    return results.map((r) => ({ ...r, sourceRef: `${row.id}::${r.sourceRef}` }))
  } catch {
    return []
  }
}

/** Fans out across every ENABLED indexer in parallel. */
export async function searchIndexer(query: string): Promise<BookSearchResult[]> {
  const rows = (await db.select().from(bookIndexers)).filter((r) => r.enabled)
  if (!rows.length) return []
  const results = await Promise.all(rows.map((row) => searchOneIndexer(row, query)))
  return results.flat()
}

export async function testIndexer(id: string): Promise<{ ok: boolean; resultCount?: number; error?: string }> {
  const row = await getIndexerRow(id)
  if (!row) return { ok: false, error: 'Indexer not found' }
  try {
    const results = await searchOneIndexer(row, 'a')
    return { ok: true, resultCount: results.length }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export async function resolveIndexerDownload(sourceRef: string): Promise<ResolvedDownload> {
  const sep = sourceRef.indexOf('::')
  if (sep < 0) throw new Error('Malformed indexer reference')
  const [indexerId, url] = [sourceRef.slice(0, sep), sourceRef.slice(sep + 2)]
  const row = await getIndexerRow(indexerId)
  if (!row) throw new Error('This indexer no longer exists')
  return { url, format: 'epub', headers: authHeaders(row) }
}
