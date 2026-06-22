import { db } from '@/db'
import { zimArchives } from '@/db/schema'
import { inArray } from 'drizzle-orm'
import { kiwixUrl, getKiwixState } from '@/lib/kiwix'
import { IS_WIN } from '@/lib/platform'

export interface ZimSearchResult {
  title: string
  path: string
  snippet: string
  sourceId: string
  bookName: string
}

/**
 * Search installed ZIM archives via the local zim-server.
 * Returns empty if kiwix is not ready or none of the requested sources are installed.
 * Sources are tried in the order provided — stops once `limit` results are collected.
 */
export async function zimSearch(
  sourceIds: string[],
  query: string,
  limit = 5,
): Promise<ZimSearchResult[]> {
  if (!query.trim() || sourceIds.length === 0) return []
  if (getKiwixState() !== 'ready') return []

  const rows = await db
    .select({ sourceId: zimArchives.sourceId, kiwixBookName: zimArchives.kiwixBookName })
    .from(zimArchives)
    .where(inArray(zimArchives.sourceId, sourceIds))

  // Preserve caller's priority order
  const rowBySource = new Map(rows.map(r => [r.sourceId, r]))
  const orderedRows = sourceIds.map(id => rowBySource.get(id)).filter(Boolean) as typeof rows

  const results: ZimSearchResult[] = []

  for (const row of orderedRows) {
    if (!row.kiwixBookName) continue
    if (results.length >= limit) break

    try {
      if (IS_WIN) {
        // kiwix-serve has no JSON full-text endpoint — use the title suggestion API, which
        // returns JSON. Snippets aren't available, so results are title-only on Windows.
        const url = `${kiwixUrl()}/suggest?content=${encodeURIComponent(row.kiwixBookName)}&term=${encodeURIComponent(query)}`
        const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
        if (!res.ok) continue
        const data = (await res.json()) as Array<{ value?: string; label?: string; path?: string }>
        for (const r of data) {
          if (results.length >= limit) break
          if (!r.path) continue  // skip the trailing "search for …" full-text suggestion (no path)
          results.push({
            title: r.label ?? r.value ?? r.path,
            path: r.path,
            snippet: '',
            sourceId: row.sourceId,
            bookName: row.kiwixBookName!,
          })
        }
        continue
      }

      const url =
        `${kiwixUrl()}/${row.kiwixBookName}/search` +
        `?pattern=${encodeURIComponent(query)}&format=json&count=${limit}`
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      if (!res.ok) continue

      const data = (await res.json()) as {
        results?: Array<{ title: string; path: string; snippet: string }>
      }
      for (const r of data.results ?? []) {
        if (results.length >= limit) break
        results.push({
          title: r.title,
          path: r.path,
          snippet: r.snippet ?? '',
          sourceId: row.sourceId,
          bookName: row.kiwixBookName!,
        })
      }
    } catch { /* skip this source */ }
  }

  return results
}

export function deriveZimAnswerPayload(
  results: ZimSearchResult[],
  query: string,
) {
  if (!results.length) return { gist: '', highlights: [], sources: [], depth_available: false }

  const lead = results[0]
  const gist = lead.snippet ? `${lead.title}: ${lead.snippet}` : lead.title

  const highlights = results
    .slice(1)
    .map(r => (r.snippet ? `${r.title}: ${r.snippet}` : r.title))
    .filter(Boolean)

  const sources = results.map(r => ({
    title: r.title,
    url: `/api/archives/view/${r.sourceId}/${r.path}`,
  }))

  return { gist, highlights, sources, depth_available: results.length > 1 }
}
