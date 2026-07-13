// Display helpers shared by the storefront pages.

import type { BookSearchResult } from './api'

/** Issue date for periodicals: "May 1994" when the source gives a full date,
 *  bare year otherwise. UTC keeps date-only strings from shifting a month. */
export function publishedLabel(r: BookSearchResult): string | null {
  if (r.publishedDate && /^\d{4}-\d{2}-\d{2}$/.test(r.publishedDate)) {
    const d = new Date(`${r.publishedDate}T00:00:00Z`)
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
  }
  return r.publishedYear ? String(r.publishedYear) : null
}
