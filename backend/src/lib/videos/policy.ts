// Content-policy bridge for video sources: adult-flagged items (reddit over_18,
// nsfw subreddits) are only shown when the user's effective ceiling allows sexual
// content at all. Mirrors how reader_items.is_adult gates the Bookmarks app.

import { getUserCeiling } from '@/lib/contentPolicy'

/** True when this user's content profile permits adult-flagged video content. */
export async function allowAdultVideos(userId: string): Promise<boolean> {
  const dials = await getUserCeiling(userId)
  return dials.sexual !== 'off'
}
