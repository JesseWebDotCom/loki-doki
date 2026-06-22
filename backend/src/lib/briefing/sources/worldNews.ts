// World/national headlines for the briefing + the (existing) news tool already covers
// general news; this is the briefing's compact world slice.

import type { BriefingItem } from '../types'
import { googleNewsTopic } from './rss'

export async function worldNews(limit = 2, timeoutMs = 5000): Promise<BriefingItem[]> {
  const items = await googleNewsTopic('WORLD', limit, timeoutMs)
  return items.map((i) => ({ title: i.title, detail: i.source || undefined, url: i.url }))
}
