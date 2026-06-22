// Recent notable deaths for the briefing — Google News RSS search (chosen over the
// Wikipedia "Deaths in {month}" list for freshness).

import type { BriefingItem } from '../types'
import { googleNewsSearch } from './rss'

export async function notableDeaths(limit = 2, timeoutMs = 5000): Promise<BriefingItem[]> {
  const items = await googleNewsSearch('notable deaths', limit, timeoutMs)
  return items.map((i) => ({ title: i.title, detail: i.source || undefined, url: i.url }))
}
