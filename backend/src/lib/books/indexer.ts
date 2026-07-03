// A user-configured self-hosted OPDS indexer (Calibre-Web, Kavita, COPS, etc.) —
// the escape hatch for anything beyond Gutenberg/Archive.org's public-domain
// catalogs. Config is admin-set global state, stored in the existing generic
// `tool_global_config` table (toolId: 'bookIndexer') — the same mechanism Home
// Assistant/Plex use, so no new table or admin route is needed; the existing
// GET/PUT /api/tools/config/global (requireAdmin) already covers it.
//
// Deliberately uses plain `fetch`, NOT `lib/ssrfGuard`'s safeFetch: the SSRF guard
// blocks private/LAN addresses, but a self-hosted OPDS server is almost always ON
// the LAN (e.g. a Calibre-Web instance at 192.168.x.x) — exactly what
// `backend/src/lib/homeAssistant/client.ts` does for the same reason (an
// admin-configured internal destination is trusted, unlike an arbitrary
// user-supplied URL elsewhere in the app).

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'
import { parseOpdsFeed } from './opds'
import type { BookSearchResult, ResolvedDownload } from './types'

const TOOL_ID = 'bookIndexer'

export interface IndexerConfig {
  baseUrl: string
  username: string | null
  password: string | null
}

/** Reads the admin-set OPDS indexer config, or null if unconfigured/disabled. */
export async function getIndexerConfig(): Promise<IndexerConfig | null> {
  const rows = await db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, TOOL_ID))
  let baseUrl: string | undefined
  let username: string | null = null
  let password: string | null = null
  let enabled = false
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as unknown
      if (r.key === 'base_url' && typeof v === 'string') baseUrl = v
      if (r.key === 'username' && typeof v === 'string') username = v
      if (r.key === 'password' && typeof v === 'string') password = v
      if (r.key === 'enabled') enabled = v === true
    } catch { /* malformed row — ignore */ }
  }
  if (!baseUrl?.trim() || !enabled) return null
  return { baseUrl: baseUrl.trim(), username, password }
}

function authHeaders(cfg: IndexerConfig): Record<string, string> {
  if (!cfg.username) return {}
  const token = Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

/** Build the search URL: supports the OpenSearch `{searchTerms}` placeholder
 *  convention (what most OPDS servers document for their search feed), falling
 *  back to a plain `?q=` query param appended to the configured base URL. */
function buildSearchUrl(cfg: IndexerConfig, query: string): string {
  if (cfg.baseUrl.includes('{searchTerms}')) return cfg.baseUrl.replace('{searchTerms}', encodeURIComponent(query))
  const sep = cfg.baseUrl.includes('?') ? '&' : '?'
  return `${cfg.baseUrl}${sep}q=${encodeURIComponent(query)}`
}

export async function searchIndexer(query: string): Promise<BookSearchResult[]> {
  const cfg = await getIndexerConfig()
  if (!cfg) return []
  try {
    const res = await fetch(buildSearchUrl(cfg, query), {
      headers: { Accept: 'application/atom+xml, application/xml, text/xml', ...authHeaders(cfg) },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    return parseOpdsFeed(await res.text(), res.url)
  } catch {
    return []
  }
}

/** `sourceRef` for an indexer result IS the direct acquisition URL (resolved once
 *  at search time by opds.ts) — no second lookup needed, just re-attach auth. */
export async function resolveIndexerDownload(sourceRef: string): Promise<ResolvedDownload> {
  const cfg = await getIndexerConfig()
  return { url: sourceRef, format: 'epub', headers: cfg ? authHeaders(cfg) : undefined }
}
