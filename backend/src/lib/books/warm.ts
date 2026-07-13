// Boot-time warmer for the Books browse caches. The Discover / Magazines /
// Audiobooks landings fan out to slow remote APIs on a cold cache (LibriVox alone
// was ~10s), so the FIRST visit after a restart used to stall. Warming them in the
// background at boot means the caches are hot before anyone navigates — every real
// visit then serves from memory. Fire-and-forget and fully best-effort: a failed
// warm just leaves that cache cold (the request path recomputes it as before).

import { logger } from '@/lib/logger'
import { getBuiltinSourceToggles } from './sourceToggles'
import { browseAllGutenbergCategories } from './gutenberg'
import { browseAllMagazineCategories } from './magazines'
import { browseAllLibrivoxCategories } from './librivox'
import { getStandardEbooksNewReleases } from './standardEbooks'
import { browseGoogleBooks } from './googleBooks'
import { browseOpenLibrary } from './openLibrary'
import { VISUAL_BOOK_SECTIONS } from './archiveOrg'
import type { BookContentType } from './types'

/** Warm every browse cache the landings depend on, respecting source toggles.
 *  Runs each source independently so one slow/dead source never blocks the rest. */
export async function warmBookCaches(): Promise<void> {
  const toggles = await getBuiltinSourceToggles().catch(() => null)
  if (!toggles) return
  const jobs: Array<Promise<unknown>> = []
  const track = (p: Promise<unknown>) => jobs.push(p.catch(() => {}))

  if (toggles.gutenberg) track(browseAllGutenbergCategories())
  if (toggles.archiveorg || toggles.openlibrary) {
    track(browseAllMagazineCategories({ archive: toggles.archiveorg, openLibrary: toggles.openlibrary }))
  }
  if (toggles.librivox) track(browseAllLibrivoxCategories())
  if (toggles.standardebooks) track(getStandardEbooksNewReleases())
  // Discover's visual shelves (comics/manga/etc.) — same per-type functions the
  // /visual/:type route calls, so warming them fills the same caches.
  for (const section of VISUAL_BOOK_SECTIONS) {
    const type = section.key as Exclude<BookContentType, 'book'>
    if (toggles.googlebooks) track(browseGoogleBooks(type))
    if (toggles.openlibrary) track(browseOpenLibrary(type))
  }

  await Promise.all(jobs)
  logger.info(`[books] warmed ${jobs.length} browse cache${jobs.length === 1 ? '' : 's'}`)
}
