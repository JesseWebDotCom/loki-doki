// Poster/banner/background/thumb writer for the Plex export tree — reuses already-cached
// bytes from the YouTube image cache (ytImageCache, populated by the app's own /img proxy)
// rather than re-fetching artwork from YouTube a second time.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getOrFetchImage } from '@/lib/youtube/imageCache'

async function writeImage(url: string | null, destAbsPath: string): Promise<boolean> {
  if (!url) return false
  const img = await getOrFetchImage(url)
  if (!img) return false
  await mkdir(dirname(destAbsPath), { recursive: true })
  await writeFile(destAbsPath, img.data)
  return true
}

/** poster.jpg / banner.jpg / background.jpg at the show root (Plex Local Media Assets —
 *  TV shows convention). Banner doubles as background when no separate art exists, which
 *  is the common case for a YouTube channel (avatar + banner is all InnerTube exposes). */
export async function writeShowAssets(showDirAbs: string, opts: { avatarUrl: string | null; bannerUrl: string | null }): Promise<void> {
  await writeImage(opts.avatarUrl, `${showDirAbs}/poster.jpg`)
  await writeImage(opts.bannerUrl, `${showDirAbs}/banner.jpg`)
  await writeImage(opts.bannerUrl, `${showDirAbs}/background.jpg`)
}

export async function writeEpisodeThumb(thumbAbsPath: string, url: string | null): Promise<boolean> {
  return writeImage(url, thumbAbsPath)
}
