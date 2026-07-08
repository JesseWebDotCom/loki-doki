// Unified category taxonomy for the Videos hub's mixed view. Ids/labels/order match
// YoutubeHomePage's own TOPICS list (proven working there via live search) so YouTube's
// leg of every category is just `search(label)`; feed mappings below are each source's
// own real browseFeeds id (VIMEO_CATEGORIES, FEED_MULTIS, CREATOR_GROUPS) — a category
// with no real overlap for a source simply omits that source from its mixed shelf.
export interface VideoCategory {
  id: string
  label: string
  feeds: Partial<Record<'vimeo' | 'reddit' | 'tiktok', string>>
}

export const VIDEO_CATEGORIES: VideoCategory[] = [
  { id: 'podcasts', label: 'Podcasts', feeds: {} },
  { id: 'music', label: 'Music', feeds: { vimeo: 'music' } },
  { id: 'news', label: 'News', feeds: {} },
  { id: 'gaming', label: 'Gaming', feeds: { reddit: 'gaming' } },
  { id: 'trailers', label: 'Trailers', feeds: {} },
  { id: 'live', label: 'Live', feeds: {} },
  { id: 'comedy', label: 'Comedy', feeds: { vimeo: 'comedy', reddit: 'funny', tiktok: 'comedy' } },
  { id: 'cooking', label: 'Cooking', feeds: { reddit: 'food', tiktok: 'food' } },
  { id: 'sports', label: 'Sports', feeds: { vimeo: 'sports', reddit: 'sports', tiktok: 'sports' } },
  { id: 'technology', label: 'Technology', feeds: {} },
  { id: 'science', label: 'Science', feeds: { reddit: 'science', tiktok: 'science' } },
  { id: 'documentary', label: 'Documentary', feeds: { vimeo: 'documentary', reddit: 'docs' } },
]

export function getVideoCategory(id: string): VideoCategory | undefined {
  return VIDEO_CATEGORIES.find((c) => c.id === id)
}
