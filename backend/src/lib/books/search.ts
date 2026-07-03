// Fans a Discover-tab query out to every enabled legitimate source in parallel.
// Standard Ebooks is deliberately NOT included: their OPDS catalog requires an
// authenticated account (verified live — even the public "new releases" feed
// 401s), so there's no keyless way to search it. A user who has their own
// Standard Ebooks (or any other OPDS) access can point a self-hosted indexer at
// it instead (Admin > Integrations > Books).

import { searchGutenberg } from './gutenberg'
import { searchArchiveOrg } from './archiveOrg'
import { searchIndexer } from './indexer'
import { getBuiltinSourceToggles } from './sourceToggles'
import type { BookSearchResult } from './types'

export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  const q = query.trim()
  if (!q) return []
  const toggles = await getBuiltinSourceToggles()
  const [gutenberg, archiveOrg, indexer] = await Promise.all([
    toggles.gutenberg ? searchGutenberg(q).catch(() => []) : Promise.resolve([]),
    toggles.archiveorg ? searchArchiveOrg(q).catch(() => []) : Promise.resolve([]),
    searchIndexer(q).catch(() => []), // custom indexers have their own per-row enabled flag
  ])
  return [...gutenberg, ...archiveOrg, ...indexer]
}
